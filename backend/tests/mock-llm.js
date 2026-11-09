// A scripted OpenAI-compatible chat-completions server for agent tests.
// mock.script(step, step, ...): each request consumes one step. A step is
//   say('text') | call('tool', {args}) | calls([...]) | fail(status) | (body) => step
// Every request body is recorded in mock.requests.
const http = require('http');

const say = (text) => ({ say: text });
const call = (name, args = {}) => ({ calls: [{ name, args }] });
const calls = (list) => ({ calls: list.map(([name, args]) => ({ name, args })) });
const fail = (status = 500, message = 'mock failure') => ({ fail: status, message });

/** The JSON result of the most recent call to `tool` in a request. */
function toolResult(body, tool) {
  const msgs = body.messages;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m.role === 'tool') {
      const callMsg = msgs.slice(0, i).reverse().find((x) => x.tool_calls?.some((t) => t.id === m.tool_call_id));
      const tc = callMsg?.tool_calls.find((t) => t.id === m.tool_call_id);
      if (tc?.function.name === tool) return JSON.parse(m.content);
    }
  }
  return null;
}
const lastUser = (body) => [...body.messages].reverse().find((m) => m.role === 'user')?.content || '';
const inr = (v) => `₹${Number(v).toLocaleString('en-IN')}`;

function startMockLlm(port) {
  const requests = [];
  let steps = [];
  let seq = 0;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {};
      requests.push({ path: req.url, auth: req.headers.authorization, body });
      let step = steps.shift();
      if (typeof step === 'function') step = step(body);
      if (!step) step = fail(500, 'mock LLM: no scripted response left');
      if (step.fail) {
        res.writeHead(step.fail, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: step.message } }));
        return;
      }
      const message = { role: 'assistant', content: step.say ?? null };
      if (step.calls) {
        message.tool_calls = step.calls.map((c) => ({ id: `call_${++seq}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `mock-${seq}`, model: body.model, choices: [{ index: 0, message, finish_reason: step.calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 400 } }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    requests,
    script: (...s) => { steps = s; },
    pending: () => steps.length,
    reset: () => { steps = []; requests.length = 0; },
    close: () => new Promise((r) => server.close(r)),
  })));
}

module.exports = { startMockLlm, say, call, calls, fail, toolResult, lastUser, inr };
