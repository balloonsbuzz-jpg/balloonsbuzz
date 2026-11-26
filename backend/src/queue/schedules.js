// Work that starts by the clock rather than by a job. Called every minute, by the worker
// process or (serverless) by /internal/cron.
const logger = require('../lib/logger');
const { scheduleDriveSyncs } = require('../gallery/sync.job');
const { runDue } = require('../automations/automations.service');
const { closeDueLeads } = require('../agent/leads');

async function tickSchedules() {
  await Promise.all([
    // Periodic Drive gallery sync (only when GDRIVE_API_KEY is set).
    scheduleDriveSyncs().catch((err) => logger.warn('gallery sync scheduling failed', { error: err.message })),
    // Follow-ups and reminders (each one is created once per quote/booking, so ticking often is safe)
    runDue().catch((err) => logger.warn('automations failed', { error: err.message })),
    // Enquiries whose event day came without a booking are lost.
    closeDueLeads().catch((err) => logger.warn('closing past leads failed', { error: err.message })),
  ]);
}

module.exports = { tickSchedules };
