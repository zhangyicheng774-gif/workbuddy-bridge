// WorkBuddy 积分 → OpenAI 兼容本地桥
// 监听 127.0.0.1:8787。两种前端都能接:
//   POST /v1/chat/completions   (OpenAI Chat Completions)
//   POST /v1/responses          (OpenAI Responses)
// 上游复用 dsh-connect-workbuddy 的 lib(需自行放到 vendor/wb,宿主依赖打了桩;见 README)。
import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PORT = Number(process.env.WB_BRIDGE_PORT || 8787);
const TOKEN = process.env.WB_BRIDGE_TOKEN || 'wb-local';
// 模型统一覆盖(可用 WB_BRIDGE_MODEL 改;设成 auto 表示不覆盖,客户端给什么用什么)。
const MODEL_OVERRIDE = String(process.env.WB_BRIDGE_MODEL ?? 'deepseek-v4.1-flash').trim();
const overrideOn = () => MODEL_OVERRIDE !== '' && MODEL_OVERRIDE.toLowerCase() !== 'auto';
// 客户端配置里存的 API Key 可能和 TOKEN 不一致 → 401 收不到回复。
// 若设置了 WB_PROVIDER_CONFIG(指向宿主 provider 的 config.json),把它里面的 secret 也一并认。
const COO_PROVIDER_CFG = process.env.WB_PROVIDER_CONFIG || '';
const EXTRA_TOKENS = (() => {
  if (!COO_PROVIDER_CFG) return [];
  try {
    const j = JSON.parse(fs.readFileSync(COO_PROVIDER_CFG, 'utf8'));
    return [j.secret, j.apiKey, j.key, j.token].filter((x) => typeof x === 'string' && x.length >= 4);
  } catch {
    return [];
  }
})();
const tokenOk = (auth) => {
  if (!auth) return true;
  const v = auth.replace(/^Bearer\s+/i, '').trim();
  return v === TOKEN || EXTRA_TOKENS.includes(v);
};
const LOGFILE = HERE + 'bridge.log';

const m = await import(pathToFileURL(HERE + 'vendor/wb/index.js').href);

const log = (...a) => {
  const line = new Date().toISOString().slice(11, 19) + ' ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  try { fs.appendFileSync(LOGFILE, line + '\n'); } catch {}
};

// 只拦「同一个响应里第二个 pet_say/pet_ask」,其余调用原样放行。
// 处理方式是丢弃,不是改名:改名会让 Coopanion 把 end_turn 记进历史,
// 模型永远不知道自己那句话被吞了(历史与用户所见不一致)。
function dedupeResponseCalls(calls) {
  const out = [];
  let firstSay = null;
  for (const c of calls) {
    if (/^pet_(say|ask)$/.test(String(c.name || ''))) {
      if (firstSay) { log('GUARD dropped call_id=' + c.id + ' name=' + c.name + ' dupOf=' + firstSay.id); continue; }
      firstSay = c;
    }
    out.push(c);
  }
  return out;
}

// ---------- 图片:从工具回执里抽出来,必要时降采样 ----------
// 事故:聊天客户端把一张照片以 base64 塞进 function_call_output,
// 变成一条 1900 万字符的 tool 消息 ≈ 1330 万 token,远超 1M 窗口 →
// 上游 400「prompt is too long」,之后每一轮都发不出去(看起来像"被掐断")。
// 现在:回执里的图片一律抽出来(回执正文留 [图片 #n]),单独作为一条 user 消息带图;
// base64 超过 IMG_INLINE_MAX 的先用 PowerShell 缩到最长边 1280 / JPEG 80 再发,
// 这样 token 只按图片算(一两千),不会按字符算成上千万。
const IMG_INLINE_MAX = 300_000;          // base64 字符数(~220KB 原图)以内原样发
const IMG_MAX_EDGE = 1280;
const IMG_HARD_MAX = 24 * 1024 * 1024;   // 超过这个直接放弃,连解都不解
const SHRINK_PS1 = HERE + 'shrink-image.ps1';
const TEXT_HARD_MAX = 120_000;           // tool 回执纯文本上限(字符)

function shrinkWithPS(base64) {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SHRINK_PS1, '-Max', String(IMG_MAX_EDGE), '-Quality', '80'],
        { maxBuffer: 64 * 1024 * 1024, timeout: 30_000, windowsHide: true },
        (err, stdout) => {
          if (err) { log('缩图失败,改用占位:', err.message.slice(0, 120)); return resolve(null); }
          const b = String(stdout || '').trim();
          if (!/^[A-Za-z0-9+/=]+$/.test(b) || b.length < 100) return resolve(null);
          resolve(b);
        },
      );
      child.stdin.end(base64);
    } catch (e) {
      log('缩图起不来:', e.message);
      resolve(null);
    }
  });
}

// data:image/...;base64,xxx → 必要时缩一版;失败返回 null(调用方用文字占位)
// 同一张图可能长期留在历史里,每轮都重新缩太亏 → 按长度+首尾片段缓存。
const imgCache = new Map();
async function normalizeImageUrl(url) {
  const s = String(url || '');
  if (!s.startsWith('data:image/')) return s;              // http(s) 或空,原样
  if (s.length <= IMG_INLINE_MAX) return s;                 // 小图不动
  const key = s.length + ':' + s.slice(0, 48) + ':' + s.slice(-24);
  if (imgCache.has(key)) return imgCache.get(key);
  if (s.length > IMG_HARD_MAX) {
    log('图片过大(' + Math.round(s.length / 1024) + 'KB base64),直接跳过');
    imgCache.set(key, null);
    return null;
  }
  const comma = s.indexOf('base64,');
  if (comma < 0) return s;
  const t0 = Date.now();
  const out = await shrinkWithPS(s.slice(comma + 7));
  if (!out) return null;
  const dataUrl = 'data:image/jpeg;base64,' + out;
  log('图片压缩: ' + Math.round(s.length / 1024) + 'KB → ' + Math.round(out.length / 1024) + 'KB (' + (Date.now() - t0) + 'ms)');
  if (imgCache.size > 12) imgCache.clear();
  imgCache.set(key, dataUrl);
  return dataUrl;
}

// 把 tool 回执里的图片挖出来:返回 { text(含 [图片 #n] 占位), images }
function extractImages(value) {
  const texts = [];
  const images = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') {
      const re = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
      let last = 0, hit;
      while ((hit = re.exec(v))) {
        if (hit.index > last) texts.push(v.slice(last, hit.index));
        images.push(hit[0]);
        texts.push('[图片 #' + images.length + ']');
        last = hit.index + hit[0].length;
      }
      if (last < v.length) texts.push(v.slice(last));
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (typeof v === 'object') {
      const u = typeof v.image_url === 'string' ? v.image_url : (v.image_url && v.image_url.url) || (v.type === 'input_image' ? v.url : '');
      if (u) { images.push(u); texts.push('[图片 #' + images.length + ']'); return; }
      if (typeof v.text === 'string') { walk(v.text); return; }
      try { texts.push(JSON.stringify(v)); } catch { /* 循环引用之类,忽略 */ }
    }
  };
  walk(value);
  return { text: texts.join(''), images };
}

// 最后一条 user 消息的尾部(诊断纯文字轮用)
function tailUser(msgs) {
  for (let i = (msgs || []).length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (!msg || msg.role !== 'user') continue;
    const c = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content) ? msg.content.map((x) => (x && x.text) || '').join('') : '';
    return String(c).slice(-160);
  }
  return '';
}

// ---------- 凭据 ----------
const client = new m.WorkBuddyUpstreamClient((msg) => log('[wb-fallback]', msg));
let cred = null;
let credAt = 0;

async function getCredential(force = false) {
  if (cred && !force && Date.now() - credAt < 60_000 && cred.expiresAtMs - Date.now() > 5 * 60_000) return cred;
  const p = m.defaultDesktopAuthCandidates().find((x) => { try { fs.accessSync(x); return true; } catch { return false; } });
  if (!p) throw new Error('找不到 WorkBuddy 的登录文件,请先在 WorkBuddy 桌面端登录');
  const key = await m.readAtRestKey();
  const parsed = m.parseWorkBuddyAuth(fs.readFileSync(p, 'utf8'), p, key);
  if (!parsed) throw new Error('WorkBuddy 登录文件解不开(可能需要更新 WorkBuddy)');
  cred = parsed; credAt = Date.now();
  if (parsed.expiresAtMs - Date.now() < 5 * 60_000) {
    try {
      const r = await client.refreshToken(parsed);
      const next = r && (r.credential || r);
      if (next && next.accessToken) { cred = next; credAt = Date.now(); log('token 已刷新'); }
      else log('refresh 返回空:', JSON.stringify(r).slice(0, 300));
    } catch (e) { log('refresh 失败:', e.message); }
  }
  log('凭据就绪:', cred.nickname || cred.domain, '到期', new Date(cred.expiresAtMs).toISOString());
  return cred;
}

// ---------- 模型目录 ----------
let models = null, modelsAt = 0;
async function getModels() {
  if (models && Date.now() - modelsAt < 5 * 60_000) return models;
  try { models = await client.fetchModels(await getCredential()); modelsAt = Date.now(); }
  catch (e) { log('取目录失败,用静态兜底:', e.message); models = m.fallbackModelsFor('cn'); modelsAt = Date.now() - 4 * 60_000; }
  return models;
}

// ---------- 发给上游 ----------
async function callUpstream(chatBody) {
  const prepared = m.prepareChatBody(JSON.stringify({ ...chatBody, stream: true }), {});
  const c = await getCredential();
  const t0 = Date.now();
  const result = await client.chatStream(c, prepared);
  const r = result.response;
  if (!result.ok || !r) {
    try {
      const brief = JSON.stringify(result, (k, v) => (k === 'response' ? (v ? '[resp]' : null) : typeof v === 'string' && v.length > 400 ? v.slice(0, 400) + '…' : v));
      log('bad result:', brief.slice(0, 1200));
    } catch {}
    log('payload 大小:', JSON.stringify(chatBody).length, '字符, model=', chatBody.model);
    try {
      fs.writeFileSync(new URL('./last-fail.json', import.meta.url), JSON.stringify(chatBody, null, 1));
      log('失败请求已存 last-fail.json');
    } catch {}
    const t = r ? await r.text().catch(() => '') : '';
    const err = new Error('upstream ' + (r?.status || '?') + ': ' + (t || 'empty body').slice(0, 1000));
    err.status = r?.status || 502;
    throw err;
  }
  log('→', chatBody.model, 'stream=' + !!chatBody.__stream, Date.now() - t0 + 'ms');
  return r;
}

// 把上游 SSE 拆成 chunk 对象
async function* iterChunks(response) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { yield JSON.parse(payload); } catch {}
    }
  }
}

function aggregateOf(chunks) {
  let content = '', reasoning = '', model = '', id = '', finish = null, usage = null;
  const calls = [];
  for (const j of chunks) {
    id ||= j.id; model ||= j.model; usage ||= j.usage || null;
    const ch = (j.choices || [])[0];
    if (!ch) continue;
    const d = ch.delta || {};
    if (typeof d.content === 'string') content += d.content;
    if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = tc.index ?? 0;
        calls[i] ||= { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  }
  const msg = { role: 'assistant', content: content || null };
  if (reasoning) msg.reasoning_content = reasoning;
  const toolCalls = calls.filter(Boolean);
  if (toolCalls.length) msg.tool_calls = toolCalls;
  return { id: id || 'wbbridge-' + Date.now(), model, msg, toolCalls, finish: finish || (toolCalls.length ? 'tool_calls' : 'stop'), usage };
}

// ---------- Responses API:请求 → chat ----------
async function toChatMessages(input, instructions) {
  const msgs = [];
  if (instructions) msgs.push({ role: 'system', content: instructions });
  if (typeof input === 'string') { msgs.push({ role: 'user', content: input }); return msgs; }
  let imgCount = 0;
  for (const item of input || []) {
    if (typeof item === 'string') { msgs.push({ role: 'user', content: item }); continue; }
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call_output' || item.type === 'function_call_result') {
      // 工具回执里可能塞着整张图的 base64(QQ 发图就是这样),绝不能原样当文字发上去:
      // 一条 1900 万字符的回执 ≈ 1330 万 token,直接顶爆 1M 窗口。见文件上方事故注释。
      const { text, images } = extractImages(item.output);
      let out = text;
      if (!out.trim()) out = images.length ? '' : '(无输出)';
      if (out.length > TEXT_HARD_MAX) {
        out = out.slice(0, TEXT_HARD_MAX) + '\n…(回执过长,已截断:' + (out.length - TEXT_HARD_MAX) + ' 字符没发)';
        log('工具回执截断: 原 ' + text.length + ' 字符');
      }
      msgs.push({ role: 'tool', tool_call_id: item.call_id || item.id || '', content: out || '(无输出)' });
      if (images.length) {
        const parts = [{ type: 'text', text: '[上面那条工具回执里带的图片]' }];
        for (const [i, raw] of images.entries()) {
          const url = await normalizeImageUrl(raw);
          if (url) { parts.push({ type: 'image_url', image_url: { url } }); imgCount++; }
          else parts.push({ type: 'text', text: '(图片 #' + (i + 1) + ' 太大,已省略)' });
        }
        msgs.push({ role: 'user', content: parts });
      }
      continue;
    }
    if (item.type === 'function_call') {
      msgs.push({
        role: 'assistant', content: null,
        tool_calls: [{ id: item.call_id || item.id || ('call_' + Math.random().toString(36).slice(2)), type: 'function', function: { name: item.name || '', arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) } }],
      });
      continue;
    }
    if (item.type === 'reasoning') continue;
    if (item.type === 'message' || item.role) {
      const role = item.role === 'developer' ? 'system' : (item.role || 'user');
      let text = '';
      const imgs = [];
      if (typeof item.content === 'string') text = item.content;
      else for (const c of item.content || []) {
        if (!c) continue;
        if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text' || c.type === 'summary_text') text += c.text || '';
        else if (c.type === 'input_image') {
          const url = await normalizeImageUrl(c.image_url || c.url || '');
          if (url) { imgs.push({ type: 'image_url', image_url: { url } }); imgCount++; }
          else text += '(图片太大,已省略)';
        }
        else if (c.type === 'refusal') text += c.refusal || '';
      }
      msgs.push({ role, content: imgs.length ? [{ type: 'text', text }, ...imgs] : text });
    }
  }
  if (imgCount) log('本轮带图 ' + imgCount + ' 张(已按需压缩)');
  return keepNativeToolHistory(msgs);
}

// 【2026-10-31 13:3x 改】仿照直连:历史里的 tool_calls / tool 结果原样保留。
//
// 原先这里把工具往来全摊平成纯文字,还把「纯工具调用的那一轮」直接丢掉 ——
// 结果模型在长对话里翻回去,只看得见一堆普通文字,**看不到自己以前是怎么调
// pet_say 说话的**,于是也跟着写成纯文字,气泡就没了。直连之所以稳,正是因为
// Coopanion 原生结构里这些调用记录都在,模型有样学样。
//
// 但上游对 tool_calls ↔ tool 结果的配对极其挑剔(错一个就 400 code 11148
// "tool calls and tool results do not match"),所以保留结构的同时补配对:
// 缺的结果补空、孤立的 tool 结果降级成 user 文字。
function keepNativeToolHistory(msgs) {
  // 先按 call_id 把结果收进表里:上游对「结果必须紧跟调用、一个不多一个不少」极挑剔,
  // 并行调用时 Coopanion 来的顺序可能是 call A / call B / 结果 A / 结果 B,靠相邻匹配会错配。
  const results = new Map();
  for (const m of msgs) {
    if (m.role === 'tool' && m.tool_call_id && !results.has(String(m.tool_call_id))) results.set(String(m.tool_call_id), m);
  }
  const out = [];
  const used = new Set();      // 已经用过的 call id(上游撞 id 也会报配对错)
  const consumed = new Set();  // 已经被认领的结果
  let dropped = 0;
  for (const m of msgs) {
    if (m.role === 'tool') continue;   // 结果统一在对应调用后面重发
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) { out.push(m); continue; }
    const callsOut = [], resOut = [];
    for (const tc of m.tool_calls) {
      const f = tc.function || { name: tc.name || '', arguments: tc.arguments };
      const origId = String(tc.id || '');
      let id = origId;
      if (!id || used.has(id)) {
        let n = 1;
        id = (origId || 'call') + '_r' + n;
        while (used.has(id)) { n++; id = (origId || 'call') + '_r' + n; }
      }
      used.add(id);
      const args = typeof f.arguments === 'string' ? f.arguments : JSON.stringify(f.arguments ?? {});
      callsOut.push({ id, type: 'function', function: { name: f.name || '', arguments: args } });
      const r = id === origId ? results.get(origId) : undefined;
      if (r) consumed.add(origId);
      resOut.push({
        role: 'tool',
        tool_call_id: id,
        content: r ? (typeof r.content === 'string' ? r.content : JSON.stringify(r.content)) : '（无输出）',
      });
    }
    out.push({ role: 'assistant', content: typeof m.content === 'string' ? m.content : '', tool_calls: callsOut });
    out.push(...resOut);
  }
  // 找不到任何调用的结果:丢掉,免得上游判定「结果多了」
  for (const id of results.keys()) if (!consumed.has(id)) dropped++;
  if (dropped) log('配对修补:丢掉 ' + dropped + ' 条没有对应调用的工具结果');
  return out;
}

// 把消息序列压成一行 A[call_a,call_b] T[call_a] … ,对上 400 时一眼能看出配在哪
function toolTrace(msgs) {
  const s = [];
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) s.push('A[' + m.tool_calls.map((t) => t.id).join(',') + ']');
    else if (m.role === 'tool') s.push('T[' + m.tool_call_id + ']');
    else s.push({ system: 'S', user: 'U', assistant: 'a' }[m.role] || m.role);
  }
  return s.join(' ');
}

function toChatTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t) continue;
    if (t.type === 'function') {
      if (t.function) out.push({ type: 'function', function: t.function });
      else out.push({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } } });
    }
  }
  return out.length ? out : undefined;
}

const ids = () => 'resp_' + Math.random().toString(36).slice(2, 14);

// ---------- 谁能看图 ----------
// 本地 16x16 红图,问模型「底色是什么」;答红/red 就算能看图。
let probeCache = null, probeAt = 0;
async function probeImages() {
  if (probeCache && Date.now() - probeAt < 10 * 60_000) return probeCache;
  const list = (await getModels()) || [];
  const out = [];
  // 1x1 纯红 PNG
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  for (const mdl of list) {
    const r = { id: mdl.id, supportsImages: !!mdl.supportsImages };
    if (!r.supportsImages) { out.push(r); continue; }
    try {
      const body = { model: mdl.id, stream: true, max_tokens: 32,
        messages: [{ role: 'user', content: [
          { type: 'text', text: '这张图是什么颜色?只答一个词。' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] }] };
      const t0 = Date.now();
      const resp = await callUpstream(body);
      let txt = '';
      for await (const j of iterChunks(resp)) {
        const d = ((j.choices || [])[0] || {}).delta || {};
        if (typeof d.content === 'string') txt += d.content;
      }
      r.said = String(txt).slice(0, 60);
      r.canSee = /红|red/i.test(r.said);
      r.ms = Date.now() - t0;
    } catch (e) { r.err = e.message.slice(0, 120); }
    out.push(r);
  }
  probeCache = out; probeAt = Date.now();
  return out;
}

// ---------- HTTP ----------
const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname.replace(/^(\/v1)+(?=\/|$)/, '') || '/';
  try {
    if (req.method === 'GET' && (p === '/healthz' || p === '/')) {
      return send(res, 200, { ok: true, service: 'workbuddy-bridge', port: PORT, routes: ['/v1/models', '/v1/chat/completions', '/v1/responses'] });
    }

    if (req.method === 'GET' && p === '/profiles') {
      const list = await getModels();
      let imgs = [];
      try { imgs = await probeImages(); } catch (e) { imgs = [{ err: e.message }]; }
      return send(res, 200, { models: list, imageProbe: imgs });
    }

    if (req.method === 'GET' && p === '/models') {
      const list = await getModels();
      return send(res, 200, {
        object: 'list',
        data: (list || []).map((x) => ({
          id: x.id, object: 'model', owned_by: 'workbuddy', created: 0,
          name: m.workBuddyDisplayName ? m.workBuddyDisplayName(x) : x.name,
          context_window: x.contextWindow, credit_multiplier: x.creditMultiplier,
          supports_images: x.supportsImages, supports_tool_call: x.supportsToolCall,
        })),
      });
    }

    if (req.method !== 'POST' || (p !== '/chat/completions' && p !== '/responses')) {
      log('404 ' + req.method + ' ' + url.pathname);
      return send(res, 404, { error: { message: 'no such route: ' + url.pathname } });
    }

    const auth = String(req.headers.authorization || '');
    if (!tokenOk(auth)) { log('401 拒绝: auth 长度', String(auth).length); return send(res, 401, { error: { message: 'bad token', type: 'auth' } }); }

    const chunksBuf = [];
    for await (const c of req) chunksBuf.push(c);
    const rawText = Buffer.concat(chunksBuf).toString('utf8') || '{}';
    let body;
    try { body = JSON.parse(rawText); } catch { return send(res, 400, { error: { message: 'body 不是 JSON' } }); }
    const modelIn = String(body.model || '');
    if (overrideOn() && body.model !== MODEL_OVERRIDE) body.model = MODEL_OVERRIDE;
    log('←', req.method, url.pathname, 'model=' + body.model + (modelIn && modelIn !== body.model ? '(客户端给 ' + modelIn + ')' : ''), 'stream=' + !!body.stream, 'tools=' + (Array.isArray(body.tools) ? body.tools.length : 0), 'body=' + rawText.slice(0, 700));

    // ---- 统一转成 chat 请求 ----
    let chatBody, wantStream;
    let spokeAlready = false;   // 本轮是否已经对用户说过话(只统计有执行回执的 pet_say/pet_ask),用来写回合状态
    if (p === '/responses') {
      wantStream = !!body.stream;
      chatBody = {
        model: body.model,
        messages: await toChatMessages(body.input, body.instructions),
        stream: true,
      };
      const tools = toChatTools(body.tools);
      if (tools) {
        chatBody.tools = tools;
        if (body.tool_choice) chatBody.tool_choice = body.tool_choice;
        // 工具多到 50+ 时,Wide 上游模型容易「只答文字、一个工具都不调」(实测 Coopanion 那 56 个工具时
        // 每轮都是「工具调用 0 个」,气泡自然不弹)。开头钉一句硬指令把它逼回工具里。
        chatBody.messages = [
          { role: 'system', content: '你有工具可用。\n- 需要看屏幕、读写文件或操作电脑时,必须调用对应工具,不要只用文字描述。\n- 说话走 pet_say(或 pet_ask):一个用户回合最多说一次,说完就停。\n- 没有要说的话、也没有要做的事,直接调用 end_turn;不必为了凑一次工具调用去硬调别的工具。' },
          ...chatBody.messages,
        ];
        // 光在开头钉一句不够长历史会把它冲淡(实测:55 条消息的会话里仍是「工具调用 0 个」)。
        // 所以在生成点旁边补一条**回合状态**:只陈述历史里的既成事实(说过几次话、有没有回执),
        // 不喊「不要再说」。
        //
        // 早先这里是往最后一条 user 消息末尾追加 NUDGE,禁令一句比一句重,结果是模型被压到
        // 「必须调工具、又不许说话」,只能调 end_turn(日志里成片的「文字 0 字 / end_turn」)。
        // 现在改成:状态贴成独立 system 消息,不污染用户原话;压制交给事实而不是命令。
        const items = Array.isArray(body.input) ? body.input : [];
        let lastUserItem = -1;
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it && typeof it === 'object' && it.type !== 'function_call' && it.type !== 'function_call_output' && it.role !== 'assistant') { lastUserItem = i; break; }
        }
        const callsThisTurn = items.slice(lastUserItem + 1).filter((it) => it && typeof it === 'object' && it.type === 'function_call');
        // 只认「真的执行过」的调用:没有 function_call_output 的 pet_say,气泡根本没弹出来,
        // 若也算「说过」,模型以为说过、用户什么也没看到,两边就对不上。
        const done = new Set(items
          .filter((it) => it && typeof it === 'object' && (it.type === 'function_call_output' || it.type === 'function_call_result'))
          .map((it) => String(it.call_id || it.id || '')));
        const spokenCalls = callsThisTurn.filter((c) => done.has(String(c.call_id || c.id || '')) && /^pet_(say|ask)$/.test(String(c.name || '')));
        spokeAlready = spokenCalls.length > 0;
        const turnState = spokeAlready
          ? '回合状态(由上面的历史推导):本轮你已经对用户说过 ' + spokenCalls.length + ' 次话(pet_say/pet_ask 都有执行回执,用户看到了)。除非用户又发了新消息,本轮不要再调用 pet_say/pet_ask;还有别的事要做就继续调别的工具,没有就调用 end_turn。'
          : '回合状态:本轮你还没有对用户说过话。要说就用 pet_say(一个回合最多一次),说完就停;没有要说的就直接调用 end_turn。';
        // 贴的位置:紧跟最后一条 user 消息;若它后面还跟着工具调用/结果,就贴到末尾,
        // 免得把 assistant 的 tool_calls 和它对应的 tool 结果拆开(上游会报配对错)。
        const ms = chatBody.messages;
        let lastUserMsg = -1;
        for (let i = ms.length - 1; i >= 0; i--) if (ms[i].role === 'user') { lastUserMsg = i; break; }
        const toolishAfterUser = lastUserMsg >= 0 && ms.slice(lastUserMsg + 1).some((x) => x.role === 'tool' || Array.isArray(x.tool_calls));
        if (lastUserMsg >= 0 && !toolishAfterUser) ms.splice(lastUserMsg + 1, 0, { role: 'system', content: turnState });
        else ms.push({ role: 'system', content: turnState });
        log('回合状态: 已说 ' + spokenCalls.length + ' 次 → ' + (spokeAlready ? 'quiet' : 'speak'));
      }
      if (body.max_output_tokens) chatBody.max_tokens = body.max_output_tokens;
      if (body.temperature != null) chatBody.temperature = body.temperature;
      if (body.top_p != null) chatBody.top_p = body.top_p;
      if (body.parallel_tool_calls != null) chatBody.parallel_tool_calls = body.parallel_tool_calls;
      if (body.text && body.text.format && body.text.format.type === 'json_object') chatBody.response_format = { type: 'json_object' };
    } else {
      wantStream = !!body.stream;
      chatBody = { ...body };
      delete chatBody.stream_options;
    }

    const imgMsgs = (Array.isArray(chatBody.messages) ? chatBody.messages : []).filter((m) => Array.isArray(m.content)).length;
    log('发上游: tools=' + (Array.isArray(chatBody.tools) ? chatBody.tools.length : 0) + ' 含图消息=' + imgMsgs + ' 消息数=' + (chatBody.messages || []).length);
    log('配对: ' + toolTrace(chatBody.messages || []));
    const offeredTools = Array.isArray(chatBody.tools) && chatBody.tools.length > 0;
    // 兜底:模型一个工具都没调(常见于「只输出纯文字」)。此时客户端不认为回合结束,
    // 会每 3 秒左右把同一条请求重发一遍(实测一轮烧几十次上游),屏幕上却什么都没发生。
    // 补一个 end_turn 当终局信号:不篡改模型已有的调用,只在"一个都没有"时收尾。
    const closeIfNoCall = (calls, text) => {
      if (calls.length || !offeredTools) return calls;
      log('兜底: 0 工具调用 → 追加 end_turn 收尾 | 用户原话尾=' + JSON.stringify(tailUser(chatBody.messages)) + ' | 模型文字=' + JSON.stringify(String(text || '').slice(0, 200)));
      return [{ id: 'call_' + Math.random().toString(36).slice(2, 12), name: 'end_turn', args: '{}' }];
    };
    const resp = await callUpstream(chatBody);
    // 重复调用在下面两条出口处统一用 dedupeResponseCalls 丢掉(只丢重复,不改名)。

    // ============ Chat Completions ============
    if (p === '/chat/completions') {
      if (wantStream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(dec.decode(value, { stream: true }), 'utf8'));
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const all = [];
      for await (const j of iterChunks(resp)) all.push(j);
      const agg = aggregateOf(all);
      return send(res, 200, {
        id: agg.id, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
        model: agg.model || body.model,
        choices: [{ index: 0, message: agg.msg, finish_reason: agg.finish }],
        usage: agg.usage || undefined,
      });
    }

    // ============ Responses ============
    const rid = ids();
    const createdAt = Math.floor(Date.now() / 1000);
    const baseResp = (status, output, usage) => ({
      id: rid, object: 'response', created_at: createdAt, status,
      model: body.model, output: output || [],
      output_text: (output || []).filter((o) => o.type === 'message').flatMap((o) => o.content.map((c) => c.text)).join(''),
      usage: usage || null,
      parallel_tool_calls: body.parallel_tool_calls !== false,
      tool_choice: body.tool_choice || 'auto',
      tools: body.tools || [],
      error: null, incomplete_details: null, instructions: body.instructions ?? null,
      max_output_tokens: body.max_output_tokens ?? null, previous_response_id: body.previous_response_id ?? null,
      reasoning: body.reasoning ?? null, store: body.store ?? false, temperature: body.temperature ?? null,
      text: body.text ?? { format: { type: 'text' } }, top_p: body.top_p ?? null,
      truncation: 'disabled', user: body.user ?? null, metadata: body.metadata ?? {},
    });

    if (!wantStream) {
      const all = [];
      for await (const j of iterChunks(resp)) all.push(j);
      const agg = aggregateOf(all);
      const output = [];
      if (agg.msg.content) output.push({ id: 'msg_' + rid.slice(5), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: agg.msg.content, annotations: [] }] });
      const keptCalls = closeIfNoCall(
        dedupeResponseCalls(agg.toolCalls.map((tc) => ({ id: tc.id, name: tc.function.name, args: tc.function.arguments }))),
        agg.msg.content,
      );
      for (const c of keptCalls) {
        output.push({ id: 'fc_' + Math.random().toString(36).slice(2, 10), type: 'function_call', status: 'completed', call_id: c.id, name: c.name, arguments: c.args });
      }
      const u = agg.usage || {};
      return send(res, 200, baseResp('completed', output, {
        input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0,
        total_tokens: u.total_tokens || 0,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
      }));
    }

    // 流式:把 chat chunk 转成 Responses 事件
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    let seq = 0;
    const emit = (type, obj) => {
      res.write('event: ' + type + '\n');
      res.write('data: ' + JSON.stringify({ type, sequence_number: seq++, ...obj }) + '\n\n');
    };

    emit('response.created', { response: baseResp('in_progress', []) });
    emit('response.in_progress', { response: baseResp('in_progress', []) });

    const msgId = 'msg_' + rid.slice(5);
    let msgStarted = false;
    let text = '';
    const calls = [];
    let usage = null;

    const startMsg = () => {
      if (msgStarted) return;
      msgStarted = true;
      emit('response.output_item.added', { output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
      emit('response.content_part.added', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    };

    for await (const j of iterChunks(resp)) {
      usage ||= j.usage || null;
      const ch = (j.choices || [])[0];
      if (!ch) continue;
      const d = ch.delta || {};
      if (typeof d.content === 'string' && d.content) {
        startMsg();
        text += d.content;
        emit('response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: d.content });
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          calls[i] ||= { id: '', name: '', args: '' };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) calls[i].args += tc.function.arguments;
        }
      }
    }

    const nCalls = calls.filter(Boolean).length;
    log('本轮结果: 文字 ' + text.length + ' 字, 工具调用 ' + nCalls + ' 个' + (nCalls ? '(' + calls.filter(Boolean).map((c) => c.name).join(',') + ')' : ''));
    if (text.length >= 120) log('文字预览: ' + JSON.stringify(text.slice(0, 180)) + ' … ' + JSON.stringify(text.slice(-80)));
    let outIndex = 0;
    if (msgStarted) {
      emit('response.output_text.done', { item_id: msgId, output_index: 0, content_index: 0, text });
      emit('response.content_part.done', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
      emit('response.output_item.done', { output_index: 0, item: { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } });
      outIndex = 1;
    }

    const toolItems = [];
    let idx = outIndex;
    for (const c of closeIfNoCall(dedupeResponseCalls(calls.filter(Boolean)), text)) {
      const fcId = 'fc_' + Math.random().toString(36).slice(2, 10);
      emit('response.output_item.added', { output_index: idx, item: { id: fcId, type: 'function_call', status: 'in_progress', call_id: c.id, name: c.name, arguments: '' } });
      emit('response.function_call_arguments.delta', { item_id: fcId, output_index: idx, delta: c.args });
      emit('response.function_call_arguments.done', { item_id: fcId, output_index: idx, arguments: c.args });
      emit('response.output_item.done', { output_index: idx, item: { id: fcId, type: 'function_call', status: 'completed', call_id: c.id, name: c.name, arguments: c.args } });
      toolItems.push({ id: fcId, type: 'function_call', status: 'completed', call_id: c.id, name: c.name, arguments: c.args });
      idx++;
    }

    const outItems = [];
    if (msgStarted) outItems.push({ id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
    outItems.push(...toolItems);
    const u = usage || {};
    emit('response.completed', {
      response: baseResp('completed', outItems, {
        input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0, total_tokens: u.total_tokens || 0,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
      }),
    });
    return res.end();
  } catch (e) {
    log('ERR:', e.message);
    if (!res.headersSent) send(res, e.status || 500, { error: { message: e.message, type: 'upstream', status: e.status } });
    else try { res.end(); } catch {}
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log('WorkBuddy 桥已启动: http://127.0.0.1:' + PORT + '  token=' + (TOKEN ? '需要' : '无'));
  getCredential().catch((e) => log('预热凭据失败:', e.message));
});
