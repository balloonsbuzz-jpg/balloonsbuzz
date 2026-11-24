// Polls the jobs table and runs handlers with bounded concurrency.
const os = require('os');
const crypto = require('crypto');
const logger = require('../lib/logger');
const jobs = require('./jobs');

function createWorker({ handlers, queues = ['default'], concurrency = 4, pollMs = 1000 }) {
  const workerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
  let running = 0;
  let stopped = false;
  let timer = null;
  let lastRecover = 0;

  async function runJob(job) {
    const handler = handlers[job.name];
    try {
      if (!handler) throw new jobs.PermanentError(`No handler for job "${job.name}"`);
      await handler(job.payload, job);
      await jobs.complete(job);
    } catch (err) {
      const r = await jobs.fail(job, err).catch((e) => ({ final: true, e }));
      const level = r.final ? 'error' : 'warn';
      logger[level](`job ${r.final ? 'failed' : 'will retry'}`, {
        job: job.name, id: job.id, attempt: job.attempts, error: err.message, retryInMs: r.delayMs,
      });
    }
  }

  /** One polling pass; returns how many jobs were started. Exposed for tests. */
  async function tick() {
    if (Date.now() - lastRecover > 60_000) {
      lastRecover = Date.now();
      const n = await jobs.recoverStale().catch(() => 0);
      if (n) logger.warn('recovered stale jobs', { count: n });
    }
    const free = concurrency - running;
    if (free <= 0) return 0;
    const claimed = await jobs.claim({ workerId, queues, limit: free });
    for (const job of claimed) {
      running += 1;
      runJob(job).finally(() => { running -= 1; });
    }
    return claimed.length;
  }

  /** Runs jobs until the queue is idle (no running, nothing ready). For tests and scripts. */
  async function drain({ timeoutMs = 20_000 } = {}) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const started = await tick();
      if (!started && running === 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('drain timed out');
  }

  function loop() {
    if (stopped) return;
    tick()
      .catch((err) => logger.error('worker poll failed', { error: err.message }))
      .finally(() => { if (!stopped) timer = setTimeout(loop, running > 0 ? Math.min(pollMs, 200) : pollMs); });
  }

  return {
    workerId,
    start() { logger.info('worker started', { workerId, queues, concurrency }); loop(); },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      const end = Date.now() + 15_000;
      while (running > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    },
    tick,
    drain,
    running: () => running,
  };
}

module.exports = { createWorker };
