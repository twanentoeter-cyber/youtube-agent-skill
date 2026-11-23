#!/usr/bin/env node
'use strict';
/*
 * AI Kantoor — lokale server.
 * Leest actieve Claude Code-sessies uit ~/.claude en toont ze als medewerkers.
 * Geen externe packages nodig. Start: node server.js   (demo: node server.js --demo)
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 4747;
const HOST = process.env.HOST || '127.0.0.1';
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const RECENT_HOURS = Number(process.env.RECENT_HOURS) || 8;      // gesloten chats tonen tot zoveel uur oud
const SLEEP_MINUTES = Number(process.env.SLEEP_MINUTES) || 30;   // klaar + zo lang stil => slaapt
const DEMO = process.argv.includes('--demo');
const NAMES_FILE = path.join(__dirname, 'office-names.json');

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');

const PERSONA_NAMES = ['Noor', 'Daan', 'Sanne', 'Milan', 'Lotte', 'Bram', 'Fleur', 'Jesse', 'Isa', 'Thijs',
  'Emma', 'Lucas', 'Julia', 'Sem', 'Eva', 'Finn', 'Zoë', 'Ruben', 'Lieke', 'Max', 'Anouk', 'Teun', 'Roos', 'Jens'];

// Tools die normaal binnen een paar seconden klaar zijn. Hangt zo'n tool lang, dan wacht
// de sessie waarschijnlijk op jouw toestemming.
const QUICK_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'TodoWrite', 'TaskCreate', 'TaskUpdate']);

/* ---------------- helpers ---------------- */
const clip = (s, n = 70) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = (p) => (p ? String(p).split(/[\\/]/).filter(Boolean).pop() : '');
const tsMs = (t) => { const v = Date.parse(t); return Number.isFinite(v) ? v : 0; };

function describeTool(name, input = {}) {
  switch (name) {
    case 'Bash': case 'PowerShell': return input.description ? clip(input.description, 60) : 'terminal: ' + clip(input.command, 45);
    case 'Read': return 'leest ' + base(input.file_path);
    case 'Edit': case 'MultiEdit': return 'bewerkt ' + base(input.file_path);
    case 'Write': return 'schrijft ' + base(input.file_path);
    case 'NotebookEdit': return 'bewerkt notebook ' + base(input.notebook_path);
    case 'Grep': return `zoekt naar “${clip(input.pattern, 40)}”`;
    case 'Glob': return 'zoekt bestanden ' + clip(input.pattern, 40);
    case 'WebSearch': return 'zoekt online: ' + clip(input.query, 50);
    case 'WebFetch': try { return 'leest ' + new URL(input.url).hostname; } catch { return 'leest een webpagina'; }
    case 'Agent': case 'Task': return 'stuurt een helper aan: ' + clip(input.description || input.prompt, 45);
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return 'plant taken';
    case 'AskUserQuestion': return 'stelt je een vraag';
    case 'ExitPlanMode': return 'wil een plan laten goedkeuren';
    case 'Skill': return 'gebruikt skill ' + clip(input.skill || input.command, 40);
    case 'ToolSearch': return 'zoekt gereedschap';
  }
  if (name && name.startsWith('mcp__')) {
    const [, srv, tool] = name.split('__');
    return `gebruikt ${srv}: ${String(tool || '').replace(/_/g, ' ')}`;
  }
  return 'gebruikt ' + (name || 'een tool');
}

function cleanPrompt(t) {
  if (!t) return null;
  t = String(t);
  const cmd = t.match(/<command-name>(.*?)<\/command-name>/s);
  if (cmd) {
    const args = t.match(/<command-args>(.*?)<\/command-args>/s);
    return clip(cmd[1] + (args && args[1].trim() ? ' ' + args[1] : ''), 200);
  }
  if (/^\s*<(local-command|system-reminder|task-notification|bash-|command-message)/.test(t)) return null;
  if (/^Caveat:/.test(t)) return null;
  return clip(t, 200);
}

const endsWithQuestion = (t) => !!t && /\?\s*[*_`)"”'»\]]*\s*$/.test(String(t).slice(-300));

/* ---------------- names / seats ---------------- */
let names = { seats: {}, custom: {} }; // seats: id -> {name, seat}
try { names = Object.assign(names, JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'))); } catch { /* eerste start */ }
let namesDirty = false;
function persona(id) {
  if (!names.seats[id]) {
    const used = new Set(Object.values(names.seats).map((s) => s.name));
    let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    let name = null;
    for (let i = 0; i < PERSONA_NAMES.length; i++) {
      const n = PERSONA_NAMES[(h + i) % PERSONA_NAMES.length];
      if (!used.has(n)) { name = n; break; }
    }
    if (!name) name = PERSONA_NAMES[h % PERSONA_NAMES.length] + ' ' + (Object.keys(names.seats).length + 1);
    const seat = Object.values(names.seats).reduce((m, s) => Math.max(m, s.seat), 0) + 1;
    names.seats[id] = { name, seat };
    namesDirty = true;
  }
  return { name: names.custom[id] || names.seats[id].name, seat: names.seats[id].seat };
}
setInterval(() => {
  if (!namesDirty) return;
  namesDirty = false;
  fs.writeFile(NAMES_FILE, JSON.stringify(names, null, 2), () => {});
}, 3000).unref();

/* ---------------- transcript index & analysis ---------------- */
const index = new Map(); // sessionId -> {file, mtimeMs, size, project}
let lastIndexScan = 0;

async function scanIndex() {
  lastIndexScan = Date.now();
  let projects;
  try { projects = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return; }
  const cutoff = Date.now() - RECENT_HOURS * 3600e3;
  await Promise.all(projects.filter((d) => d.isDirectory()).map(async (d) => {
    const dir = path.join(PROJECTS_DIR, d.name);
    let files; try { files = await fsp.readdir(dir); } catch { return; }
    await Promise.all(files.filter((f) => f.endsWith('.jsonl')).map(async (f) => {
      const file = path.join(dir, f);
      try {
        const st = await fsp.stat(file);
        const id = f.slice(0, -6);
        if (st.mtimeMs >= cutoff || index.has(id)) index.set(id, { file, mtimeMs: st.mtimeMs, size: st.size, project: d.name });
      } catch { /* verdwenen */ }
    }));
  }));
}

async function readChunk(file, start, len) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
}
function parseLines(text, dropFirst) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  const out = [];
  for (const l of lines) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* half geschreven regel */ } }
  return out;
}

const analysisCache = new Map(); // file -> {mtimeMs, size, info}
const TAIL_BYTES = 768 * 1024;

async function analyze(file) {
  let st; try { st = await fsp.stat(file); } catch { return null; }
  const cached = analysisCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.info;

  const start = Math.max(0, st.size - TAIL_BYTES);
  const entries = parseLines(await readChunk(file, start, st.size - start), start > 0);
  const info = {
    file, mtimeMs: st.mtimeMs, title: null, titleCustom: false, lastPrompt: null, cwd: null, branch: null,
    lastText: null, lastTs: 0, lastKind: null, pending: [], helpers: [], turnEnded: false,
  };
  const pending = new Map();
  for (const e of entries) {
    if (e.cwd) info.cwd = e.cwd;
    if (e.gitBranch) info.branch = e.gitBranch;
    if (e.type === 'custom-title' && (e.customTitle || e.title)) { info.title = e.customTitle || e.title; info.titleCustom = true; }
    else if (e.type === 'ai-title' && e.aiTitle && !info.titleCustom) info.title = e.aiTitle;
    else if (e.type === 'summary' && e.summary && !info.title) info.title = e.summary;
    else if (e.type === 'last-prompt' && e.lastPrompt) info.lastPrompt = cleanPrompt(e.lastPrompt) || info.lastPrompt;
    if (e.isSidechain) continue;

    if (e.type === 'assistant') {
      const c = e.message && e.message.content;
      if (!Array.isArray(c)) continue;
      info.lastTs = Math.max(info.lastTs, tsMs(e.timestamp));
      for (const it of c) {
        if (it.type === 'text' && it.text && it.text.trim()) { info.lastText = it.text; info.lastKind = 'text'; info.turnEnded = false; }
        else if (it.type === 'tool_use') { pending.set(it.id, { name: it.name, input: it.input || {}, ts: tsMs(e.timestamp), id: it.id }); info.lastKind = 'tool_use'; info.turnEnded = false; }
      }
    } else if (e.type === 'user' && !e.isMeta) {
      const c = e.message && e.message.content;
      info.lastTs = Math.max(info.lastTs, tsMs(e.timestamp));
      const handleText = (t) => {
        if (/^\[Request interrupted/.test(t)) { pending.clear(); info.lastKind = 'interrupted'; info.turnEnded = true; return; }
        const p = cleanPrompt(t);
        if (p) { pending.clear(); info.lastKind = 'prompt'; info.turnEnded = false; if (!info.lastPrompt) info.lastPrompt = p; }
      };
      if (typeof c === 'string') handleText(c);
      else if (Array.isArray(c)) for (const it of c) {
        if (it.type === 'tool_result') { pending.delete(it.tool_use_id); info.lastKind = 'tool_result'; }
        else if (it.type === 'text' && it.text) handleText(it.text);
      }
    } else if (e.type === 'system' && e.subtype === 'stop_hook_summary') {
      info.turnEnded = true;
    }
  }
  info.pending = [...pending.values()];
  info.helpers = info.pending.filter((p) => p.name === 'Agent' || p.name === 'Task');

  if (!info.title && start > 0) { // titel staat soms alleen vooraan in het bestand
    const head = parseLines(await readChunk(file, 0, Math.min(st.size, 256 * 1024)), false);
    for (const e of head) {
      if (e.type === 'custom-title' && (e.customTitle || e.title)) { info.title = e.customTitle || e.title; break; }
      if (e.type === 'ai-title' && e.aiTitle) info.title = e.aiTitle;
      if (e.type === 'summary' && e.summary && !info.title) info.title = e.summary;
    }
  }
  if (!info.lastTs) info.lastTs = st.mtimeMs;
  analysisCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info });
  return info;
}

/* ---------------- live registry (~/.claude/sessions/*.json) ---------------- */
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
let registryExists = false;
async function readRegistry() {
  const out = new Map();
  let files;
  try { files = await fsp.readdir(SESSIONS_DIR); registryExists = true; } catch { registryExists = false; return out; }
  await Promise.all(files.filter((f) => f.endsWith('.json')).map(async (f) => {
    try {
      const r = JSON.parse(await fsp.readFile(path.join(SESSIONS_DIR, f), 'utf8'));
      if (r && r.sessionId && pidAlive(r.pid)) out.set(r.sessionId, r);
    } catch { /* onvolledig bestand */ }
  }));
  return out;
}

/* ---------------- hook events & externe agents ---------------- */
const hooks = new Map();     // sessionId -> laatste hook-event
const external = new Map();  // id -> handmatig gemelde agent (POST /api/agents)
const HOOK_LIVE_MS = 30 * 60e3;

function recordHook(h) {
  const id = h.session_id || h.sessionId;
  if (!id) return false;
  const prev = hooks.get(id) || {};
  hooks.set(id, {
    event: h.hook_event_name || h.event || 'Unknown', ts: Date.now(),
    tool: h.tool_name, input: h.tool_input, message: h.message,
    cwd: h.cwd || prev.cwd, transcript: h.transcript_path || prev.transcript,
  });
  if (h.transcript_path && !index.has(id)) index.set(id, { file: h.transcript_path, mtimeMs: Date.now(), size: 0, project: '' });
  return true;
}

/* ---------------- status ---------------- */
function statusFor({ info, reg, hook, live, now }) {
  const lastActivity = Math.max(info ? info.lastTs : 0, hook ? hook.ts : 0, reg ? (reg.statusUpdatedAt || 0) : 0);
  const idle = now - lastActivity;
  const res = (status, activity, reason) => ({ status, activity: activity || null, reason: reason || null, lastActivity });

  if (!live) return res('sleeping', null, 'chat gesloten');

  // 1) Hooks zijn het meest precies, als ze nieuwer zijn dan het transcript.
  if (hook && hook.ts >= (info ? info.lastTs : 0) - 1500) {
    switch (hook.event) {
      case 'Notification': {
        const m = String(hook.message || '');
        return res('waiting', null, /permission|toestemming/i.test(m) ? 'toestemming nodig' : (m ? clip(m, 60) : 'heeft je nodig'));
      }
      case 'PreToolUse':
        if (hook.tool === 'AskUserQuestion') return res('waiting', null, 'stelt je een vraag');
        if (hook.tool === 'ExitPlanMode') return res('waiting', null, 'plan ter goedkeuring');
        return res('working', describeTool(hook.tool, hook.input || {}));
      case 'PostToolUse': case 'UserPromptSubmit': case 'SubagentStop': case 'SessionStart':
        if (hook.event === 'SessionStart') break;
        return res('working', 'denkt na…');
      case 'SessionEnd': return res('sleeping', null, 'chat gesloten');
      // 'Stop' => verder naar de rust-beoordeling hieronder
    }
  }

  const regStatus = reg && reg.status ? String(reg.status) : '';
  if (/wait|input|permission|block|ask|approv/i.test(regStatus)) return res('waiting', null, 'heeft je nodig');
  const busy = regStatus
    ? /busy|running|working|thinking|active/i.test(regStatus)
    : (info && !info.turnEnded && info.lastKind !== 'text' && idle < 3 * 60e3);
  const hookStopped = hook && hook.event === 'Stop' && hook.ts >= (info ? info.lastTs : 0) - 1500;

  const p = info && info.pending.length ? info.pending[info.pending.length - 1] : null;
  if (p && !hookStopped) {
    if (p.name === 'AskUserQuestion') return res('waiting', null, 'stelt je een vraag');
    if (p.name === 'ExitPlanMode') return res('waiting', null, 'plan ter goedkeuring');
    const age = now - p.ts;
    if (!busy && regStatus) return res('waiting', null, 'toestemming nodig: ' + describeTool(p.name, p.input));
    if (QUICK_TOOLS.has(p.name) && age > 25e3) return res('waiting', null, 'toestemming nodig? ' + describeTool(p.name, p.input));
    return res('working', describeTool(p.name, p.input));
  }
  if (busy && !hookStopped) {
    const act = info && info.lastKind === 'tool_result' ? 'verwerkt het resultaat'
      : info && info.lastKind === 'prompt' && info.lastPrompt ? 'denkt na over “' + clip(info.lastPrompt, 40) + '”'
      : 'denkt na…';
    return res('working', act);
  }
  if (info && info.lastKind === 'text' && endsWithQuestion(info.lastText)) return res('waiting', null, 'heeft een vraag voor je');
  if (idle > SLEEP_MINUTES * 60e3) return res('sleeping', null, 'al ' + Math.round(idle / 60e3) + ' min stil');
  return res('done', info && info.lastText ? clip(info.lastText.split('\n').find((l) => l.trim()) || '', 70) : null);
}

/* ---------------- state ---------------- */
async function buildState() {
  const now = Date.now();
  if (now - lastIndexScan > 15e3) await scanIndex();
  const reg = await readRegistry();
  const ids = new Set([...reg.keys()]);
  for (const [id, h] of hooks) if (now - h.ts < HOOK_LIVE_MS) ids.add(id);
  for (const [id, f] of index) if (now - f.mtimeMs < RECENT_HOURS * 3600e3) ids.add(id);

  const agents = [];
  await Promise.all([...ids].map(async (id) => {
    const r = reg.get(id);
    const hook = hooks.get(id);
    const idx = index.get(id);
    const info = idx ? await analyze(idx.file) : null;
    if (idx && info) idx.mtimeMs = info.mtimeMs;
    const hookLive = hook && now - hook.ts < HOOK_LIVE_MS && hook.event !== 'SessionEnd';
    const live = !!r || !!hookLive || (!registryExists && info && now - info.mtimeMs < 15 * 60e3);
    if (!live && info && now - info.mtimeMs > RECENT_HOURS * 3600e3) return;
    if (!info && !r && !hook) return;

    const st = statusFor({ info, reg: r, hook, live, now });
    const p = persona(id);
    const cwd = (r && r.cwd) || (hook && hook.cwd) || (info && info.cwd) || '';
    agents.push({
      id, kind: 'claude', name: p.name, seat: p.seat, live,
      title: (info && info.title) || (r && r.name) || (info && info.lastPrompt) || 'Nieuwe chat',
      project: base(cwd) || (idx && idx.project) || '', cwd, branch: info && info.branch,
      ...st,
      lastPrompt: info && info.lastPrompt, lastText: info && info.lastText ? (info.lastText.length > 900 ? info.lastText.slice(0, 899) + '…' : info.lastText) : null,
      entrypoint: r && r.entrypoint, resume: `claude --resume ${id}`,
    });
    // Subagents die nu draaien krijgen een helper-bureau naast hun baas.
    if (live && info && st.status === 'working') {
      for (const h of info.helpers) {
        const hp = persona(id + ':' + h.id);
        agents.push({
          id: id + ':' + h.id, kind: 'helper', parentId: id, parentName: p.name, name: hp.name, seat: p.seat + 0.001 * hp.seat,
          live: true, title: clip(h.input.description || 'Subtaak', 60), project: base(cwd),
          status: 'working', activity: clip(h.input.subagent_type ? h.input.subagent_type + ': ' + (h.input.description || '') : h.input.description || 'subtaak', 60),
          lastActivity: h.ts, lastPrompt: clip(h.input.prompt, 300),
        });
      }
    }
  }));

  for (const a of external.values()) {
    const age = now - a.updatedAt;
    if (age > 12 * 3600e3) { external.delete(a.id); continue; }
    const p = persona('ext:' + a.id);
    agents.push({
      id: 'ext:' + a.id, kind: 'external', name: a.name || p.name, seat: p.seat, live: age < 3600e3,
      title: a.title || 'Externe agent', project: a.project || '',
      status: age > 3600e3 ? 'sleeping' : a.status, activity: a.activity || null, reason: a.reason || null, lastActivity: a.updatedAt,
    });
  }

  if (DEMO) agents.push(...demoAgents(now));
  agents.sort((a, b) => a.seat - b.seat);
  return { generatedAt: now, claudeDir: CLAUDE_DIR, registry: registryExists, hooksSeen: hooks.size > 0, agents };
}

/* ---------------- demo ---------------- */
function demoAgents(now) {
  const phase = Math.floor(now / 8000);
  const cyc = (arr, k) => arr[(phase + k) % arr.length];
  const mk = (id, title, project, status, activity, reason) => {
    const p = persona('demo:' + id);
    return { id: 'demo:' + id, kind: 'claude', name: p.name, seat: p.seat, live: status !== 'sleeping', title, project, status, activity, reason,
      lastActivity: now - 20e3, lastPrompt: 'Demo-opdracht voor ' + title, lastText: 'Dit is een demo-medewerker.', resume: 'claude --resume demo-' + id };
  };
  const out = [
    mk('a', 'Stranded Sam: Shorts-scripts', 'youtube-agent-skill', 'working', cyc(['schrijft s1e2-shorts.md', 'zoekt online: north sea storm facts', 'leest s1e1-the-rig-shorts.md'], 0)),
    mk('b', 'Login-bug in de webshop', 'webshop', 'waiting', null, 'toestemming nodig: npm test'),
    mk('c', 'Banner exporteren', 'branding', 'done', 'Banner staat klaar in branding/stranded-sam/'),
    mk('d', 'Database-migratie', 'api-server', cyc(['working', 'working', 'waiting', 'done'], 1), 'terminal: npx prisma migrate dev', 'stelt je een vraag'),
    mk('e', 'Oude refactor', 'website', 'sleeping', null, 'chat gesloten'),
  ];
  const hp = persona('demo:a:helper');
  out.push({ id: 'demo:a:helper', kind: 'helper', parentId: 'demo:a', parentName: out[0].name, name: hp.name, seat: out[0].seat + 0.001,
    live: true, title: 'Feiten checken', project: 'youtube-agent-skill', status: 'working', activity: 'Explore: survival-feiten verifiëren', lastActivity: now });
  return out;
}

/* ---------------- http ---------------- */
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('te groot')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const STATUSES = new Set(['working', 'waiting', 'done', 'sleeping']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await fsp.readFile(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await buildState());

    if (req.method === 'POST' && url.pathname === '/api/hook') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return json(res, recordHook(body) ? 200 : 400, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/agents') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (!b.id) return json(res, 400, { error: 'id is verplicht' });
      const status = STATUSES.has(b.status) ? b.status : 'working';
      external.set(String(b.id), { id: String(b.id), name: b.name, title: b.title, project: b.project, status, activity: b.activity, reason: b.reason, updatedAt: Date.now() });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/agents/')) {
      external.delete(decodeURIComponent(url.pathname.slice('/api/agents/'.length)));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/rename') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (!b.id) return json(res, 400, { error: 'id is verplicht' });
      const name = clip(b.name || '', 24);
      if (name) names.custom[b.id] = name; else delete names.custom[b.id];
      namesDirty = true;
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'niet gevonden' });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  🏢  AI Kantoor draait op http://localhost:${PORT}`);
  console.log(`      Leest sessies uit: ${CLAUDE_DIR}${DEMO ? '   (demo-medewerkers aan)' : ''}\n`);
});
