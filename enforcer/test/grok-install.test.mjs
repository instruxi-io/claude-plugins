import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, uninstall, grokAgent, mergeMcp } from '../src/grok-install.mjs';

const ok = (m) => console.log('  ok  ' + m);
const mk = () => mkdtempSync(join(tmpdir(), 'grok-inst-'));
const quiet = { out: () => {} };
const baks = (d) => readdirSync(d).filter((f) => f.includes('.enforcer-bak'));

// hooks point under ~/.config/enforcer/grok
let home = mk();
await install({ home, yes: true, ...quiet });
const hooks = readFileSync(join(home, '.grok/hooks/enforcer.json'), 'utf8');
const j = JSON.parse(hooks);
assert.ok(j.hooks.SessionStart.at(-1).hooks[0].command.includes(join(home, '.config/enforcer/grok')) && !hooks.includes('__ENFORCER_ROOT__'));
assert.ok(existsSync(join(home, '.config/enforcer/grok/VERSION')));
assert.equal(j.hooks.SessionEnd[0].hooks[0].timeout, 1);
assert.ok(existsSync(j.hooks.PreToolUse[0].hooks[0].command.match(/node "([^"]+shim\.mjs)"/)[1]));
ok('hooks point under ~/.config/enforcer/grok');

// idempotent: no backup
await install({ home, yes: true, ...quiet });
assert.equal(baks(join(home, '.grok')).length + baks(join(home, '.grok/hooks')).length + baks(join(home, '.grok/agents')).length, 0);
ok('second run with no change writes no backup');

// dry run writes nothing
const h2 = mk();
await install({ home: h2, dryRun: true, ...quiet });
assert.equal(existsSync(join(h2, '.grok')), false);
assert.equal(existsSync(join(h2, '.config')), false);

// differing section refused with a diff; user keys / array lines survive an unchanged merge
const h3 = mk(); mkdirSync(join(h3, '.grok'), { recursive: true });
const mine = '[mcp_servers.enforcer]\nurl = "https://other.example/mcp"\n';
writeFileSync(join(h3, '.grok/config.toml'), mine);
const lines = []; const r = await install({ home: h3, yes: true, out: (s) => lines.push(s) });
assert.equal(r.ok, false); assert.match(r.diff, /other\.example/);
assert.equal(readFileSync(join(h3, '.grok/config.toml'), 'utf8'), mine);
assert.ok(lines.join('\n').includes('+ url'));
const same = '[mcp_servers.enforcer]\nurl = "https://api.instruxi.dev/mcp"\nargs = [\n  "a",\n[1]\n]\n[other]\nx = 1\n';
assert.equal(mergeMcp(same, readFileSync(new URL('../harness/grok/config.toml.snippet', import.meta.url), 'utf8')).status, 'unchanged');
ok('existing differing section is refused with a diff');

// uninstall removes only manifest paths
const h4 = mk(); mkdirSync(join(h4, '.grok/agents'), { recursive: true });
writeFileSync(join(h4, '.grok/agents/mine.md'), 'keep');
writeFileSync(join(h4, '.grok/config.toml'), '[model]\nname = "x"\n');
await install({ home: h4, yes: true, ...quiet });
const res = await uninstall({ home: h4, yes: true, ...quiet });
assert.equal(readFileSync(join(h4, '.grok/agents/mine.md'), 'utf8'), 'keep');
assert.equal(readFileSync(join(h4, '.grok/config.toml'), 'utf8').trim(), '[model]\nname = "x"');
assert.equal(existsSync(join(h4, '.grok/hooks/enforcer.json')), false);
assert.equal(existsSync(join(h4, '.config/enforcer/grok')), false);
assert.ok(res.removed.length >= 4);
ok('uninstall removes only manifest paths');

const a = grokAgent(readFileSync(new URL('../agents/graph-worker.md', import.meta.url), 'utf8'));
assert.ok(a.includes('enforcer__graph_next_work') && !/mcp__/.test(a));
assert.match(a, /^model: /m); assert.match(a, /^tools: /m);
ok('agent body uses enforcer__graph_ names');
