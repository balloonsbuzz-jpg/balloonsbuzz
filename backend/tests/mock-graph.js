// A fake Meta Graph API for tests. Queue responses with mock.respond(); every
// request is recorded in mock.requests.
const http = require('http');

function startMockGraph(port) {
  const requests = [];
  const queue = [];   // [{ status, body, headers }]
  let seq = 0;
  let defaultReply = (req) => {
    if (req.method === 'POST' && /\/messages$/.test(req.path)) {
      seq += 1;   // unique for the whole run (reset() must not recycle wamids)
      return { status: 200, body: { messaging_product: 'whatsapp', messages: [{ id: `wamid.MOCK${Date.now()}_${seq}` }] } };
    }
    if (req.method === 'GET') {
      return { status: 200, body: { display_phone_number: '+91 93925 34625', verified_name: 'BalloonsBuzz', quality_rating: 'GREEN', id: '123' } };
    }
    return { status: 200, body: {} };
  };

  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const entry = { method: req.method, path: req.url.split('?')[0], url: req.url, auth: req.headers.authorization, body: data ? JSON.parse(data) : null };
      requests.push(entry);
      const r = queue.length ? queue.shift() : defaultReply(entry);
      res.writeHead(r.status, { 'Content-Type': 'application/json', ...(r.headers || {}) });
      res.end(JSON.stringify(r.body));
    });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    requests,
    respond: (status, body, headers) => queue.push({ status, body, headers }),
    reset: () => { requests.length = 0; queue.length = 0; },
    setDefault: (fn) => { defaultReply = fn; },
    close: () => new Promise((r) => server.close(r)),
  })));
}

const graphError = (code, message, status = 400) => ({ status, body: { error: { message, type: 'OAuthException', code, fbtrace_id: 'x' } } });

module.exports = { startMockGraph, graphError };
