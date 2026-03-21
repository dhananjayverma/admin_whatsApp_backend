const whatsappQueue = require('../queues/whatsappQueue');
const Recipient = require('../models/Recipient');
const Campaign = require('../models/Campaign');
const MessageLog = require('../models/MessageLog');
const waClient = require('../services/whatsappClientService');
const numberPool = require('../services/numberPoolService');
const logger = require('../utils/logger');

const CONCURRENCY = 3;
const DEFAULT_DELAY_MIN = 4000;
const DEFAULT_DELAY_MAX = 10000;

/** Return a random integer between min and max (inclusive). */
function randomDelay(min, max) {
  const lo = Math.max(0, min);
  const hi = Math.max(lo + 500, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}


function classifyError(err) {
  const msg = (err.message || '').toLowerCase();

  // Hard ban of our sending number by Meta
  if (
    msg.includes('banned') ||
    msg.includes('your account has been') ||
    msg.includes('account banned') ||
    msg.includes('account suspended') ||
    msg.includes('spamming') ||
    msg.includes('unauthorized') ||
    msg.includes('auth failure') ||
    msg.includes('403')
  ) return 'sender_blocked';

  // Rate-limit / soft block
  if (
    msg.includes('rate limit') ||
    msg.includes('rate-limit') ||
    msg.includes('too many') ||
    msg.includes('flood') ||
    msg.includes('slow down')
  ) return 'rate_limited';

  // Recipient not on WhatsApp
  if (
    msg.includes('not on whatsapp') ||
    msg.includes('no lid for user') ||
    msg.includes('invalid wid') ||
    msg.includes('not a contact') ||
    msg.includes('phone number shared')
  ) return 'not_on_whatsapp';

  // Browser/connection crash
  if (
    msg.includes('target closed') ||
    msg.includes('protocol error') ||
    msg.includes('session closed') ||
    msg.includes('getchats') ||
    err.name === 'TargetCloseError'
  ) return 'technical';

  return 'recipient_failure';
}


async function autoPauseCampaign(campaignId, reason, blockedNumberId = null) {
  const update = {
    status: 'paused',
    pausedAt: new Date(),
    pauseReason: reason,
  };
  if (blockedNumberId) update.blockedNumberId = blockedNumberId;
  await Campaign.updateOne({ _id: campaignId }, { $set: update });
  logger.warn('Campaign auto-paused', { campaignId, reason, blockedNumberId });
}

async function processJob(job) {
  const { campaignId, recipientIds, delayMin, delayMax } = job.data;

  // Resolve delay range (randomised per message)
  const dMin = typeof delayMin === 'number' && delayMin >= 0 ? delayMin : DEFAULT_DELAY_MIN;
  const dMax = typeof delayMax === 'number' && delayMax >= dMin ? delayMax : Math.max(dMin + 2000, DEFAULT_DELAY_MAX);

  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign) {
    logger.warn('Campaign not found', campaignId);
    return;
  }

  // If campaign was paused (e.g. by a sibling worker job), skip this chunk
  if (campaign.status === 'paused' || campaign.status === 'cancelled') {
    logger.info('Campaign paused/cancelled — skipping chunk', { campaignId, status: campaign.status });
    return;
  }

  const messageBody = campaign.messageBody || '';
  const recipients = await Recipient.find({ _id: { $in: recipientIds }, status: 'pending' }).lean();

  for (let i = 0; i < recipients.length; i++) {
    const rec = recipients[i];

    // Re-check campaign status before each send in case it was paused externally
    const freshCampaign = await Campaign.findById(campaignId).select('status').lean();
    if (!freshCampaign || freshCampaign.status === 'paused' || freshCampaign.status === 'cancelled') {
      logger.info('Campaign paused/cancelled mid-chunk — stopping', { campaignId });
      return;
    }

    // Pick a virtual number for this message (rotate per message)
    const virtualNumber = await numberPool.getNextNumber();
    let virtualNumberId = null;
    let clientId = null;

    if (virtualNumber) {
      virtualNumberId = virtualNumber._id;
      // Use the number's linked WhatsApp account if available, else fall back to pool
      clientId = virtualNumber.whatsappClientId || null;
    }

    let sent = false;
    let lastErr = null;

    try {
      // Send via specific account or fallback to round-robin
      if (clientId) {
        await waClient.sendViaClientId(clientId, rec.phone, messageBody);
      } else {
        await waClient.sendMessage(rec.phone, messageBody);
      }
      sent = true;
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);

      if (kind === 'sender_blocked') {
        // Our sending number is hard-blocked
        logger.error('Sending number BLOCKED by Meta/operator', { phone: virtualNumber?.number, err: err.message });

        if (virtualNumberId) {
          await numberPool.markBlocked(virtualNumberId, `meta_block: ${err.message.slice(0, 120)}`);
          await numberPool.setCooldown(virtualNumberId);
        }

        // Try to get the next available number and retry this recipient once
        const fallback = await numberPool.getNextNumber();
        if (fallback) {
          try {
            const fbClientId = fallback.whatsappClientId || null;
            if (fbClientId) {
              await waClient.sendViaClientId(fbClientId, rec.phone, messageBody);
            } else {
              await waClient.sendMessage(rec.phone, messageBody);
            }
            sent = true;
            virtualNumberId = fallback._id;
            await numberPool.recordSuccess(fallback._id);
          } catch (retryErr) {
            lastErr = retryErr;
            logger.error('Retry send failed after number rotation', { phone: rec.phone, err: retryErr.message });
          }
        }

        // If still not sent, check if all numbers are exhausted → auto-pause
        if (!sent) {
          const allGone = await numberPool.areAllNumbersExhausted();
          if (allGone) {
            await autoPauseCampaign(
              campaignId,
              'all_numbers_blocked — All virtual numbers are blocked or exhausted. Please add new numbers or wait for cooldown to reset.',
              virtualNumberId
            );
            // Mark this recipient as failed and stop the job
            await Recipient.updateOne({ _id: rec._id }, { status: 'failed', failureReason: 'No available sending numbers' });
            await Campaign.updateOne({ _id: campaignId }, { $inc: { failedCount: 1 } });
            await MessageLog.create({ campaignId, recipientId: rec._id, virtualNumberId, status: 'failed', sentAt: new Date(), meta: { reason: 'all_numbers_blocked' } });
            return; // Stop processing this chunk
          }
        }
      } else if (kind === 'rate_limited') {
        logger.warn('Rate limited on sending number', { phone: virtualNumber?.number });
        if (virtualNumberId) {
          // Extended cooldown for rate limiting (5× normal)
          const redis = require('../config/redis').getRedis();
          const { COOLDOWN_SECONDS } = require('../config/env');
          await redis.set(numberPool.cooldownKey(virtualNumberId.toString()), '1', 'EX', COOLDOWN_SECONDS * 5);
          await numberPool.recordFailure(virtualNumberId);
        }
      } else if (kind === 'technical') {
        // Connection/browser crash — don't penalise the number, just log
        logger.warn('Technical send error (connection/browser)', { phone: rec.phone, err: err.message });
      } else if (kind !== 'not_on_whatsapp') {
        // Generic recipient failure — track consecutive failures on the number
        if (virtualNumberId) {
          const autoBlocked = await numberPool.recordFailure(virtualNumberId);
          if (autoBlocked) {
            const allGone = await numberPool.areAllNumbersExhausted();
            if (allGone) {
              await autoPauseCampaign(
                campaignId,
                'all_numbers_blocked — All virtual numbers hit failure threshold. Please review your numbers.',
                virtualNumberId
              );
              await Recipient.updateOne({ _id: rec._id }, { status: 'failed', failureReason: lastErr?.message || 'send error' });
              await Campaign.updateOne({ _id: campaignId }, { $inc: { failedCount: 1 } });
              await MessageLog.create({ campaignId, recipientId: rec._id, virtualNumberId, status: 'failed', sentAt: new Date(), meta: { reason: lastErr?.message } });
              return;
            }
          }
        }
      }
    }

    if (sent) {
      await Recipient.updateOne({ _id: rec._id }, { status: 'sent', sentAt: new Date() });
      await Campaign.updateOne({ _id: campaignId }, { $inc: { sentCount: 1 } });
      await MessageLog.create({ campaignId, recipientId: rec._id, virtualNumberId, status: 'sent', sentAt: new Date() });
      if (virtualNumberId) {
        await numberPool.recordSuccess(virtualNumberId);
        await numberPool.setCooldown(virtualNumberId);
      }
      logger.info(`Sent to ${rec.phone} (${i + 1}/${recipients.length})`);
    } else {
      const reason = lastErr?.message || 'unknown error';
      await Recipient.updateOne({ _id: rec._id }, { status: 'failed', failureReason: reason });
      await Campaign.updateOne({ _id: campaignId }, { $inc: { failedCount: 1 } });
      await MessageLog.create({ campaignId, recipientId: rec._id, virtualNumberId, status: 'failed', sentAt: new Date(), meta: { reason } });
      logger.error(`Failed to send to ${rec.phone}`, reason);
    }

    // Randomised delay between messages (skip after last)
    if (i < recipients.length - 1) {
      const ms = randomDelay(dMin, dMax);
      logger.debug(`Delay ${ms}ms before next message`);
      await sleep(ms);
    }
  }

  // Mark campaign completed if no pending recipients remain
  const pendingLeft = await Recipient.countDocuments({ campaignId, status: 'pending' });
  if (pendingLeft === 0) {
    // Only mark completed if not paused by another job
    await Campaign.updateOne(
      { _id: campaignId, status: { $nin: ['paused', 'cancelled'] } },
      { $set: { status: 'completed', completedAt: new Date() } }
    );
    logger.info('Campaign completed', { campaignId });
  }
}

function initWorker() {
  whatsappQueue.process(CONCURRENCY, processJob);
  logger.info('WhatsApp worker started', { concurrency: CONCURRENCY });
}

// Allow standalone run: node workers/whatsappWorker.js
if (require.main === module) {
  const { connectDB } = require('../config/db');
  connectDB()
    .then(async () => {
      await waClient.initAll();
      initWorker();
    })
    .catch((err) => {
      logger.error('Worker failed to start', err);
      process.exit(1);
    });
}

module.exports = { initWorker };
