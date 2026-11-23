#!/usr/bin/env node
// Claude Code-hook: stuurt het hook-event door naar het AI Kantoor.
// Blokkeert nooit: als de server niet draait, gebeurt er gewoon niets.
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', async () => {
  const port = process.env.AI_OFFICE_PORT || 4747;
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    await fetch(`http://127.0.0.1:${port}/api/hook`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: data || '{}', signal: ac.signal,
    });
  } catch { /* kantoor staat uit: negeren */ }
  process.exit(0);
});
