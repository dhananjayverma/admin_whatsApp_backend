const { EventEmitter } = require('events');

// Shared event bus — workers emit here, SSE endpoints subscribe here.
// Events emitted: { type, campaignId, reason, ... }
const campaignEvents = new EventEmitter();
campaignEvents.setMaxListeners(100);

module.exports = campaignEvents;
