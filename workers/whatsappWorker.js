const whatsappQueue = require('../queues/whatsappQueue');
const Recipient = require('../models/Recipient');
const Campaign = require('../models/Campaign');
const MessageLog = require('../models/MessageLog');
const waClient = require('../services/whatsappClientService');
const numberPool = require('../services/numberPoolService');
const campaignEvents = require('../services/campaignEvents');
const logger = require('../utils/logger');
const { DEFAULT_DELAY_MIN, DEFAULT_DELAY_MAX } = require('../config/env');

const CONCURRENCY = 3;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Human-like delay — no uniform distribution pattern.
 * Simulates burst sending, natural pauses, and occasional long breaks.
 */
function humanDelay(dMin, dMax, msgIndex) {
  // ~4% chance per message of a long break (averages 1 break every 25 messages)
  if (msgIndex > 0 && Math.random() < 0.04) {
    const breakMs = 60000 + Math.floor(Math.random() * 240000); // 1–5 min
    logger.debug(`[Delay] Long break ${Math.round(breakMs / 1000)}s at message ${msgIndex}`);
    return breakMs;
  }

  // 15% chance: burst mode (very short gap — mimics typing quickly)
  if (Math.random() < 0.15) {
    return 1000 + Math.floor(Math.random() * 2000); // 1–3s
  }

  // Normal: provided range + ±30% jitter so each delay is unique
  const lo = Math.max(0, dMin);
  const hi = Math.max(lo + 500, dMax);
  const base = lo + Math.floor(Math.random() * (hi - lo + 1));
  const jitter = Math.floor(base * (Math.random() * 0.6 - 0.3));
  return Math.max(500, base + jitter);
}

/**
 * Expand spintax — {A|B|C} becomes one random choice.
 * Handles nested spintax up to 10 levels deep.
 */
function expandSpintax(text) {
  let result = text;
  for (let depth = 0; depth < 10; depth++) {
    const prev = result;
    result = result.replace(/\{([^{}]+)\}/g, (_, choices) => {
      const opts = choices.split('|');
      return opts[Math.floor(Math.random() * opts.length)];
    });
    if (result === prev) break;
  }
  return result;
}

/**
 * Classify the sending error to determine how to respond.
 * Distinguishes between Meta blocks, Operator/carrier blocks,
 * rate limits, recipient issues, and technical failures.
 */
function classifyError(err) {
  const msg = (err.message || '').toLowerCase();
  const code = (err.code || '').toLowerCase();

  // Hard block by Meta (WhatsApp platform)
  if (
    msg.includes('banned') ||
    msg.includes('account banned') ||
    msg.includes('account suspended') ||
    msg.includes('your account has been') ||
    msg.includes('spamming') ||
    msg.includes('auth failure') ||
    msg.includes('logged out') ||
    (msg.includes('403') && !msg.includes('etimedout'))
  ) return 'meta_block';

  // Operator / carrier / ISP block (network-level)
  if (
    code === 'etimedout' ||
    code === 'econnreset' ||
    code === 'econnrefused' ||
    code === 'enetunreach' ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('network error') ||
    msg.includes('connection reset') ||
    msg.includes('connection refused') ||
    msg.includes('getaddrinfo') ||
    msg.includes('service unavailable') ||
    msg.includes('503') ||
    msg.includes('502')
  ) return 'operator_block';

  // Rate-limit / soft block
  if (
    msg.includes('rate limit') ||
    msg.includes('rate-limit') ||
    msg.includes('too many') ||
    msg.includes('flood') ||
    msg.includes('slow down') ||
    msg.includes('429')
  ) return 'rate_limited';

  // Recipient not on WhatsApp
  if (
    msg.includes('not on whatsapp') ||
    msg.includes('no lid for user') ||
    msg.includes('invalid wid') ||
    msg.includes('not a contact') ||
    msg.includes('phone number shared')
  ) return 'not_on_whatsapp';

  // Connection / session crash
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
  const update = { status: 'paused', pausedAt: new Date(), pauseReason: reason };
  if (blockedNumberId) update.blockedNumberId = blockedNumberId;
  await Campaign.updateOne({ _id: campaignId }, { $set: update });
  logger.warn('Campaign auto-paused', { campaignId, reason, blockedNumberId });

  // Push real-time event so admin panel updates instantly
  campaignEvents.emit('update', {
    type: 'campaign_paused',
    campaignId: campaignId.toString(),
    reason,
    blockedNumberId: blockedNumberId?.toString() || null,
  });
}

/**
 * Try to pick a virtual number whose WhatsApp session is ready.
 * If a number has no WhatsApp session provisioned, auto-start one
 * (admin will need to scan QR or enter pairing code).
 * Returns null if no ready number found after retries.
 */
async function getReadyNumber(readySessions) {
  // Pass readySessions so getNextNumber pre-filters at the DB level —
  // numbers with provisioned-but-not-ready sessions are excluded from the query,
  // preventing their daily quota from being wastefully incremented.
  for (let attempt = 0; attempt < 6; attempt++) {
    const vn = await numberPool.getNextNumber(readySessions);
    if (!vn) return null;

    // No WhatsApp session provisioned — auto-start one and skip for now
    if (!vn.whatsappClientId) {
      try {
        await waClient.provisionWhatsApp(vn._id.toString(), vn.number);
        logger.info(`[Worker] Auto-provisioned WhatsApp for ${vn.number} — admin must scan QR`);
        campaignEvents.emit('update', {
          type: 'wa_provisioning',
          numberId: vn._id.toString(),
          number: vn.number,
          message: `WhatsApp session started for ${vn.number} — scan QR in the Accounts panel`,
        });
      } catch (e) {
        logger.error(`[Worker] Failed to provision WhatsApp for ${vn.number}: ${e.message}`);
      }
      continue; // session not ready yet — try next available number
    }

    // DB filter guarantees this is in readySessions, but double-check defensively
    if (readySessions.has(vn.whatsappClientId)) return vn;
  }
  return null;
}

async function processJob(job) {
  const { campaignId, recipientIds, delayMin, delayMax } = job.data;
  const dMin = typeof delayMin === 'number' && delayMin >= 0 ? delayMin : DEFAULT_DELAY_MIN;
  const dMax = typeof delayMax === 'number' && delayMax >= dMin ? delayMax : Math.max(dMin + 3000, DEFAULT_DELAY_MAX);

  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign) { logger.warn('Campaign not found', campaignId); return; }

  if (campaign.status === 'paused' || campaign.status === 'cancelled') {
    logger.info('Campaign paused/cancelled — skipping chunk', { campaignId, status: campaign.status });
    return;
  }

  const messageBody = campaign.messageBody || '';
  const recipients = await Recipient.find({ _id: { $in: recipientIds }, status: 'pending' }).lean();

  // Cache ready WA sessions — refresh every 10 messages
  let readySessions = new Set(
    waClient.getAllStatus().filter((s) => s.status === 'ready').map((s) => s.clientId)
  );

  for (let i = 0; i < recipients.length; i++) {
    const rec = recipients[i];

    // Re-check campaign status before each send
    const freshCampaign = await Campaign.findById(campaignId).select('status').lean();
    if (!freshCampaign || freshCampaign.status === 'paused' || freshCampaign.status === 'cancelled') {
      logger.info('Campaign paused/cancelled mid-chunk — stopping', { campaignId });
      return;
    }

    // Refresh ready sessions every 10 messages
    if (i % 10 === 0) {
      readySessions = new Set(
        waClient.getAllStatus().filter((s) => s.status === 'ready').map((s) => s.clientId)
      );
    }

    // Pick a ready virtual number (auto-provisions unprovisioned ones)
    const virtualNumber = await getReadyNumber(readySessions);
    let virtualNumberId = virtualNumber?._id || null;
    const clientId = virtualNumber?.whatsappClientId || null;

    // No virtual numbers ready AND no admin sessions — pause campaign
    if (!virtualNumber && readySessions.size === 0) {
      await autoPauseCampaign(
        campaignId,
        'no_wa_sessions — No WhatsApp sessions are ready. Scan QR or enter pairing code in the Accounts panel.',
        null
      );
      await Recipient.updateOne({ _id: rec._id }, { status: 'failed', failureReason: 'No WA sessions ready' });
      await Campaign.updateOne({ _id: campaignId }, { $inc: { failedCount: 1 } });
      return;
    }

    // Expand spintax so every message is unique (defeats content-fingerprinting)
    const finalMessage = expandSpintax(messageBody);

    let sent = false;
    let lastErr = null;

    try {
      if (clientId) {
        await waClient.sendViaClientId(clientId, rec.phone, finalMessage);
      } else {
        await waClient.sendMessage(rec.phone, finalMessage);
      }
      sent = true;
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);

      if (kind === 'meta_block' || kind === 'operator_block') {
        const blockLabel = kind === 'meta_block' ? 'Meta (WhatsApp)' : 'Operator/Carrier';
        logger.error(`Sending number BLOCKED by ${blockLabel}`, { number: virtualNumber?.number, err: err.message });

        if (virtualNumberId) {
          await numberPool.markBlocked(virtualNumberId, `${kind}: ${err.message.slice(0, 120)}`);
          await numberPool.setCooldown(virtualNumberId);
        }

        // Refresh sessions and try a fallback number
        readySessions = new Set(
          waClient.getAllStatus().filter((s) => s.status === 'ready').map((s) => s.clientId)
        );
        const fallback = await getReadyNumber(readySessions);
        if (fallback) {
          try {
            const fbClientId = fallback.whatsappClientId || null;
            if (fbClientId) {
              await waClient.sendViaClientId(fbClientId, rec.phone, finalMessage);
            } else {
              await waClient.sendMessage(rec.phone, finalMessage);
            }
            sent = true;
            // Update virtualNumberId so the success/log blocks below use the correct number
            virtualNumberId = fallback._id;
          } catch (retryErr) {
            lastErr = retryErr;
            logger.error('Retry failed after number rotation', { phone: rec.phone, err: retryErr.message });
          }
        }

        if (!sent) {
          const allGone = await numberPool.areAllNumbersExhausted();
          if (allGone) {
            await autoPauseCampaign(
              campaignId,
              `all_numbers_blocked — All virtual numbers are blocked by ${blockLabel}. Add new numbers or wait for cooldown to reset.`,
              virtualNumberId
            );
            await Recipient.updateOne({ _id: rec._id }, { status: 'failed', failureReason: 'No available sending numbers' });
            await Campaign.updateOne({ _id: campaignId }, { $inc: { failedCount: 1 } });
            await MessageLog.create({ campaignId, recipientId: rec._id, virtualNumberId, status: 'failed', sentAt: new Date(), meta: { reason: 'all_numbers_blocked' } });
            return;
          }
        }
      } else if (kind === 'rate_limited') {
        logger.warn('Rate limited on sending number', { number: virtualNumber?.number });
        if (virtualNumberId) {
          const redis = require('../config/redis').getRedis();
          const { COOLDOWN_SECONDS } = require('../config/env');
          await redis.set(numberPool.cooldownKey(virtualNumberId.toString()), '1', 'EX', COOLDOWN_SECONDS * 5);
          await numberPool.recordFailure(virtualNumberId);
        }
      } else if (kind === 'technical') {
        logger.warn('Technical send error', { phone: rec.phone, err: err.message });
      } else if (kind !== 'not_on_whatsapp') {
        if (virtualNumberId) {
          const autoBlocked = await numberPool.recordFailure(virtualNumberId);
          if (autoBlocked) {
            const allGone = await numberPool.areAllNumbersExhausted();
            if (allGone) {
              await autoPauseCampaign(
                campaignId,
                'all_numbers_blocked — All virtual numbers hit the failure threshold. Review your numbers.',
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

    // Human-like delay with burst patterns, long breaks, and per-message jitter
    if (i < recipients.length - 1) {
      const ms = humanDelay(dMin, dMax, i);
      logger.debug(`Delay ${ms}ms before next message (index ${i + 1})`);
      await sleep(ms);
    }
  }

  // Mark campaign completed if no pending recipients remain
  const pendingLeft = await Recipient.countDocuments({ campaignId, status: 'pending' });
  if (pendingLeft === 0) {
    await Campaign.updateOne(
      { _id: campaignId, status: { $nin: ['paused', 'cancelled'] } },
      { $set: { status: 'completed', completedAt: new Date() } }
    );
    campaignEvents.emit('update', { type: 'campaign_completed', campaignId: campaignId.toString() });
    logger.info('Campaign completed', { campaignId });
  }
}

function initWorker() {
  whatsappQueue.process(CONCURRENCY, processJob);
  logger.info('WhatsApp worker started', { concurrency: CONCURRENCY });
}

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
