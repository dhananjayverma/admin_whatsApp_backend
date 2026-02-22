const Campaign = require('../models/Campaign');
const Recipient = require('../models/Recipient');
const User = require('../models/User');
const creditService = require('./creditService');
const whatsappQueue = require('../queues/whatsappQueue');
const { getRedis } = require('../config/redis');
const { CHUNK_SIZE, COST_PER_MESSAGE } = require('../config/env');
const logger = require('../utils/logger');

const CAMPAIGN_START_LOCK_TTL = 30;

/** Resolve campaign and check access. Returns { campaign } where campaign is owner's. ownerId = campaign.userId. */
async function getCampaignWithAccess(campaignId, user) {
  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign) throw new Error('Campaign not found');
  const ownerId = campaign.userId?.toString();
  const userId = user._id.toString();
  if (user.role === 'admin') return { campaign: { ...campaign, _id: campaign._id }, ownerId };
  if (user.role === 'client') {
    if (ownerId !== userId) throw new Error('Campaign not found');
    return { campaign: { ...campaign, _id: campaign._id }, ownerId };
  }
  if (user.role === 'reseller') {
    const client = await User.findById(ownerId).select('resellerId').lean();
    if (!client || client.resellerId?.toString() !== userId) throw new Error('Campaign not found');
    return { campaign: { ...campaign, _id: campaign._id }, ownerId };
  }
  throw new Error('Campaign not found');
}

async function create(userId, name, messageBody = '', options = {}) {
  const {
    type = 'text',
    buttonQuestion = '',
    buttonOptions = [],
  } = options;
  const campaign = await Campaign.create({
    userId,
    name: (name && String(name).trim()) || 'Untitled Campaign',
    messageBody: messageBody ? String(messageBody).slice(0, 10000) : '',
    type: ['text', 'button', 'dp'].includes(type) ? type : 'text',
    buttonQuestion: type === 'button' ? String(buttonQuestion).slice(0, 500) : '',
    buttonOptions: type === 'button' && Array.isArray(buttonOptions)
      ? buttonOptions.map((o) => String(o).slice(0, 100)).filter(Boolean)
      : [],
    status: 'draft',
  });
  return campaign;
}

async function addRecipients(campaignId, user, rows) {
  const { campaign } = await getCampaignWithAccess(campaignId, user);
  if (campaign.status !== 'draft') throw new Error('Campaign cannot be updated');

  const sanitized = (Array.isArray(rows) ? rows : []).slice(0, 100000);
  const docs = sanitized.map((r) => ({
    campaignId,
    phone: String(r.phone || r).replace(/\D/g, '').slice(0, 20),
    name: (r.name != null ? String(r.name) : (r.contactName != null ? String(r.contactName) : '')).slice(0, 200),
    status: 'pending',
  })).filter((d) => d.phone.length >= 10);

  if (docs.length === 0) return { recipientCount: await Recipient.countDocuments({ campaignId }), added: 0 };
  await Recipient.insertMany(docs);
  const recipientCount = await Recipient.countDocuments({ campaignId });
  await Campaign.updateOne({ _id: campaignId }, { recipientCount });
  return { recipientCount, added: docs.length };
}

async function start(campaignId, user) {
  const redis = getRedis();
  const lockKey = `lock:campaign:${campaignId}`;
  const locked = await redis.set(lockKey, '1', 'EX', CAMPAIGN_START_LOCK_TTL, 'NX');
  if (!locked) {
    throw new Error('Campaign start already in progress. Please wait a moment.');
  }
  try {
    const { campaign, ownerId } = await getCampaignWithAccess(campaignId, user);
    if (campaign.status !== 'draft' && campaign.status !== 'paused') {
      throw new Error('Campaign cannot be started');
    }

    const recipientCount = campaign.recipientCount || (await Recipient.countDocuments({ campaignId }));
    if (recipientCount === 0) throw new Error('No recipients');

    const totalCost = recipientCount * COST_PER_MESSAGE;
    await creditService.deduct(ownerId, totalCost, campaignId, { recipientCount });

    await Campaign.updateOne(
      { _id: campaignId },
      {
        status: 'queued',
        startedAt: new Date(),
        $inc: { creditsUsed: totalCost },
      }
    );

    const recipientIds = await Recipient.find({ campaignId, status: 'pending' })
      .select('_id')
      .lean();
    const ids = recipientIds.map((r) => r._id.toString());

    const chunks = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      chunks.push(ids.slice(i, i + CHUNK_SIZE));
    }

    for (const chunk of chunks) {
      await whatsappQueue.add(
        { campaignId: campaignId.toString(), recipientIds: chunk },
        { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
      );
    }

    await Campaign.updateOne({ _id: campaignId }, { status: 'running' });
    logger.info('Campaign started', { campaignId, chunks: chunks.length, recipientCount, ownerId });
    return { campaignId, jobsAdded: chunks.length };
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
}

async function pause(campaignId, user) {
  const { campaign } = await getCampaignWithAccess(campaignId, user);
  if (campaign.status !== 'running' && campaign.status !== 'queued') {
    throw new Error('Campaign cannot be paused');
  }
  await Campaign.updateOne({ _id: campaignId }, { status: 'paused' });
  return { status: 'paused' };
}

async function update(campaignId, user, payload) {
  const { campaign } = await getCampaignWithAccess(campaignId, user);
  if (campaign.status !== 'draft') throw new Error('Only draft campaigns can be updated');
  const update = {};
  if (payload.name !== undefined) update.name = String(payload.name).trim() || 'Untitled Campaign';
  if (payload.messageBody !== undefined) update.messageBody = String(payload.messageBody).slice(0, 10000);
  if (payload.type !== undefined && ['text', 'button', 'dp'].includes(payload.type)) {
    update.type = payload.type;
    update.buttonQuestion = payload.type === 'button' ? String(payload.buttonQuestion || '').slice(0, 500) : '';
    update.buttonOptions = payload.type === 'button' && Array.isArray(payload.buttonOptions)
      ? payload.buttonOptions.map((o) => String(o).slice(0, 100)).filter(Boolean)
      : [];
  }
  if (payload.buttonQuestion !== undefined && campaign.type === 'button') update.buttonQuestion = String(payload.buttonQuestion).slice(0, 500);
  if (payload.buttonOptions !== undefined && campaign.type === 'button') {
    update.buttonOptions = Array.isArray(payload.buttonOptions)
      ? payload.buttonOptions.map((o) => String(o).slice(0, 100)).filter(Boolean)
      : [];
  }
  if (Object.keys(update).length === 0) return Campaign.findById(campaignId).lean();
  await Campaign.updateOne({ _id: campaignId }, update);
  return Campaign.findById(campaignId).lean();
}

module.exports = { create, addRecipients, start, pause, getCampaignWithAccess, update };
