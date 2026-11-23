#!/usr/bin/env node
'use strict';
// Zet de AI Kantoor-hooks in ~/.claude/settings.json (met backup). Verwijderen: node install-hooks.js --remove
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const HOOK = path.join(__dirname, 'hook.js');
const MARK = 'ai-office';
const COMMAND = `"${process.execPath}" "${HOOK}"`;
const EVENTS = { PreToolUse: '*', PostToolUse: '*', UserPromptSubmit: null, Notification: null, Stop: null, SubagentStop: null, SessionStart: null, SessionEnd: null };
const remove = process.argv.includes('--remove');

let settings = {};
if (fs.existsSync(SETTINGS)) {
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  try { settings = JSON.parse(raw); } catch { console.error(`Kan ${SETTINGS} niet lezen (geen geldige JSON). Er is niets aangepast.`); process.exit(1); }
  const backup = `${SETTINGS}.bak-${Date.now()}`;
  fs.writeFileSync(backup, raw);
  console.log(`Backup gemaakt: ${backup}`);
} else {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
}

settings.hooks = settings.hooks || {};
const isOurs = (h) => typeof h.command === 'string' && (h.command.includes(HOOK) || (h.command.includes(MARK) && h.command.includes('hook.js')));

for (const [event, matcher] of Object.entries(EVENTS)) {
  const groups = (settings.hooks[event] || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length);
  if (!remove) {
    const group = { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] };
    if (matcher) group.matcher = matcher;
    groups.push(group);
  }
  if (groups.length) settings.hooks[event] = groups; else delete settings.hooks[event];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(remove ? 'AI Kantoor-hooks verwijderd.' : `AI Kantoor-hooks geïnstalleerd in ${SETTINGS}.\nNieuwe Claude Code-sessies melden nu hun status exact. Bestaande sessies: herstart ze.`);
