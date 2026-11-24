// Server-Sent Events: the dashboard keeps one connection open and refetches
// whatever an event says changed. Events carry ids only, never message content.
const express = require('express');
const { env } = require('../config/env');
const bus = require('../realtime/bus');

// Serverless functions are killed at 300s: end cleanly before that, the browser reconnects.
const MAX_STREAM_MS = 280_000;

const router = express.Router();

router.get('/', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',     // nginx: don't buffer
  });
  res.write(`retry: 3000\n\nevent: hello\ndata: {}\n\n`);

  const send = (e) => {
    const { tenantId, ...rest } = e;    // eslint-disable-line no-unused-vars
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(rest)}\n\n`);
  };
  const unsubscribe = bus.subscribe(req.user.tenantId, send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  const limit = env.VERCEL ? setTimeout(() => res.end(), MAX_STREAM_MS) : null;
  // On a server the listener starts at boot; a serverless instance starts it with its first stream.
  if (env.VERCEL) bus.start();
  res.on('close', () => { clearInterval(heartbeat); clearTimeout(limit); unsubscribe(); });
});

module.exports = router;
