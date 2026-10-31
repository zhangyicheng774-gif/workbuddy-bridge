// End-to-end test: a stub OpenAI-compatible upstream + this bridge.
// No network, no credentials, no real model. Run with: npm test
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(ROOT, '..', 'server.mjs');

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log('  PASS  ' + name); }
  else { failed += 1; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// One SSE chunk carrying a chat.completion.delta
function sse(chunk) {
  return 'data: ' + JSON.stringify(chunk) + '\n\n';
}

function textStream(text) {
  return sse({ id: 'stub', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
    + sse({ id: 'stub', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    + 'data: [DONE]\n\n';
}

const stub = {
  lastBody: null,
  reply: null,          // (body) => string  (SSE payload)
};

const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'stub-model', object: 'model' }] }));
  }
  if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
    stub.lastBody = JSON.parse(raw);
    const payload = stub.reply ? stub.reply(stub.lastBody) : textStream('hello from stub');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    return res.end(payload);
  }
  res.writeHead(404).end('{}');
});

async function waitFor(url, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('bridge did not start: ' + url);
}

const base = async (port, route, init = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: 'Bearer wb-local', ...(init.headers || {}) },
  });
  return r;
};

const main = async () => {
  const upPort = await freePort();
  const brPort = await freePort();
  await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));

  const child = spawn(process.execPath, [SERVER], {
    cwd: path.join(ROOT, '..'),
    env: {
      ...process.env,
      WB_BRIDGE_PORT: String(brPort),
      WB_BRIDGE_TOKEN: 'wb-local',
      WB_UPSTREAM: 'openai',
      WB_UPSTREAM_BASE_URL: `http://127.0.0.1:${upPort}/v1`,
      WB_UPSTREAM_API_KEY: 'test-key',
      WB_BRIDGE_MODEL: 'stub-model',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });

  try {
    await waitFor(`http://127.0.0.1:${brPort}/healthz`);
    console.log('\nhealth / models');
    {
      const h = await (await base(brPort, '/healthz')).json();
      check('healthz ok', h.ok === true && h.upstream === 'openai', JSON.stringify(h));
      const m = await (await base(brPort, '/v1/models')).json();
      check('/v1/models lists upstream model', m.data?.some?.((x) => x.id === 'stub-model'), JSON.stringify(m).slice(0, 200));
    }

    console.log('\nchat completions');
    {
      stub.reply = () => textStream('non-stream works');
      const r = await base(brPort, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'client-asked-for-other', messages: [{ role: 'user', content: 'hi' }], stream: false }),
      });
      const j = await r.json();
      check('non-stream content', j.choices?.[0]?.message?.content === 'non-stream works', JSON.stringify(j).slice(0, 200));
      check('model override applied', stub.lastBody?.model === 'stub-model', 'got ' + stub.lastBody?.model);
      check('upstream request is streaming', stub.lastBody?.stream === true);
    }

    console.log('\nresponses stream');
    {
      stub.reply = () => textStream('你好,桥通了');
      const r = await base(brPort, '/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ model: 'stub-model', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }),
      });
      const text = await r.text();
      const events = [...text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
      check('event: response.created', events.includes('response.created'));
      check('event: output_text.delta', events.includes('response.output_text.delta'));
      check('event: response.completed', events.includes('response.completed'));
      check('streamed text assembled', text.includes('你好,桥通了'));
    }

    console.log('\ntool-result image handling');
    {
      const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      stub.reply = () => textStream('got the picture');
      const r = await base(brPort, '/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'stub-model',
          input: [
            { type: 'function_call', call_id: 'call_1', name: 'screenshot', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call_1', output: [
              { type: 'input_text', text: 'screen:' },
              { type: 'input_image', image_url: 'data:image/png;base64,' + tinyPng },
            ] },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what color?' }] },
          ],
        }),
      });
      await r.text();
      const msgs = stub.lastBody?.messages || [];
      const tool = msgs.find((m) => m.role === 'tool');
      const withImage = msgs.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'));
      check('tool text keeps a placeholder, not base64', !!tool && tool.content.includes('[图片 #1]') && !tool.content.includes('base64'), tool?.content?.slice(0, 80));
      check('image travels as an image message', !!withImage && withImage.content.some((c) => c.type === 'image_url' && String(c.image_url.url).startsWith('data:image/png;base64,')));
    }

    console.log('\nempty-tool-call turn');
    {
      stub.reply = () => textStream('just talking');
      const r = await base(brPort, '/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'stub-model',
          stream: true,
          tools: [{ type: 'function', name: 'end_turn', description: 'end', parameters: { type: 'object', properties: {} } }],
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say hi' }] }],
        }),
      });
      const text = await r.text();
      check('end_turn appended when model calls no tool', text.includes('"name":"end_turn"'), text.slice(-300));
    }

    console.log('\nauth');
    {
      const r = await fetch(`http://127.0.0.1:${brPort}/v1/models`, { headers: { authorization: 'Bearer wrong' } });
      check('wrong token rejected', r.status === 401, 'status ' + r.status);
      const r2 = await fetch(`http://127.0.0.1:${brPort}/v1/models`);
      check('no token accepted (local convenience)', r2.status === 200, 'status ' + r2.status);
    }
  } finally {
    child.kill();
    upstream.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\n--- bridge log ---\n' + log.split('\n').slice(-25).join('\n'));
    process.exit(1);
  }
};

main().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
