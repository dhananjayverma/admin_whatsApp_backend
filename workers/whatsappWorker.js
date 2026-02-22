const whatsappQueue = require('../queues/whatsappQueue');
const Recipient = require('../models/Recipient');
const Campaign = require('../models/Campaign');
const MessageLog = require('../models/MessageLog');
const numberPoolService = require('../services/numberPoolService');
const whatsappProxyService = require('../services/whatsappProxyService');
const { connectDB } = require('../config/db');
const logger = require('../utils/logger');

const CONCURRENCY = 5;
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 3000;

function randomDelay() {
  return new Promise((r) => setTimeout(r, MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS)));
}

async function processJob(job) {
  const { campaignId, recipientIds } = job.data;
  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign) {
    logger.warn('Campaign not found', campaignId);
    return;
  }
  const messageBody = campaign.messageBody || '';

  const recipients = await Recipient.find({ _id: { $in: recipientIds }, status: 'pending' }).lean();

  for (const rec of recipients) {
    await randomDelay();

    let numberDoc = await numberPoolService.getNextNumber();
    if (!numberDoc) {
      await Recipient.updateOne(
        { _id: rec._id },
        { status: 'failed', failureReason: 'No virtual number available' }
      );
      await Campaign.updateOne({ _id: campaignId }, { $inc: { failedCount: 1 } });
      await MessageLog.create({
        campaignId,
        recipientId: rec._id,
        virtualNumberId: null,
        status: 'failed',
        meta: { reason: 'No virtual number available' },
      });
      continue;
    }

    try {
      await whatsappProxyService.sendMessage(numberDoc, rec.phone, messageBody);
      await numberPoolService.setCooldown(numberDoc._id.toString());
      await Recipient.updateOne(
        { _id: rec._id },
        { status: 'sent', sentAt: new Date(), numberUsed: numberDoc._id }
      );
      await Campaign.updateOne({ _id: campaignId }, { $inc: { sentCount: 1 } });
      await MessageLog.create({
        campaignId,
        recipientId: rec._id,
        virtualNumberId: numberDoc._id,
        status: 'sent',
        sentAt: new Date(),
      });
    } catch (err) {
      logger.error('Send failed', rec.phone, err.message);
      await Recipient.updateOne(
        { _id: rec._id },
        { status: 'failed', failureReason: err.message }
      );
      await Campaign.updateOne({ _id: campaignId }, { $inc: { failedCount: 1 } });
      await MessageLog.create({
        campaignId,
        recipientId: rec._id,
        virtualNumberId: numberDoc._id,
        status: 'failed',
        sentAt: new Date(),
        meta: { reason: err.message },
      });
    }
  }

  const pendingLeft = await Recipient.countDocuments({ campaignId, status: 'pending' });
  if (pendingLeft === 0) {
    await Campaign.updateOne(
      { _id: campaignId },
      { $set: { status: 'completed', completedAt: new Date() } }
    );
    logger.info('Campaign completed', { campaignId });
  }
}

async function run() {
  await connectDB();
  whatsappQueue.process(CONCURRENCY, processJob);
  logger.info('WhatsApp worker started', { concurrency: CONCURRENCY });
}

run().catch((err) => {
  logger.error('Worker failed', err);
  process.exit(1);
});
