// Server-Sent Events: the dashboard keeps one connection open and refetches
// whatever an event says changed. Events carry ids only, never message content.
const express = require('express');
const bus = require('../realtime/bus');

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
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
});

module.exports = router;
