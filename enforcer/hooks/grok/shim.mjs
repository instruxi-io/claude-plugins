// Grok Build shim: node shim.mjs <event <name> [--graph-only] | hook <event> [handler] | claude-shim.mjs>
// Grok's stdin already carries the common fields (hook_event_name, session_id,
// tool_name, tool_input ...). Only tool names differ: map them to the names the
// governor's rules and the graph hooks know, then hand over to the shared core.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOLS = { run_terminal_command: 'Bash', read_file: 'Read', search_replace: 'Edit', grep: 'Grep',
  list_dir: 'Glob', web_search: 'WebSearch', spawn_subagent: 'Task',
  write_file: 'Write', create_file: 'Write', edit_file: 'Edit', apply_patch: 'Edit', delete_file: 'Write' };
const PATHS = ['file_path', 'path', 'filePath', 'target_file', 'filename', 'file'];
// Grok may send tool_input / tool_response as JSON strings (or only camelCase
// copies): parse them so the shared core always sees objects, and give file
// tools a file_path the settings guard and isFileWrite look for.
const parse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
export function normalize(ev) {
  const n = ev.tool_name;
  if (typeof n === 'string') ev.tool_name = TOOLS[n] || (n.includes('__') && !n.startsWith('mcp__') ? `mcp__${n}` : n);
  if (ev.tool_input === undefined && ev.toolInput !== undefined) ev.tool_input = ev.toolInput;
  if (ev.tool_response === undefined && ev.toolResult !== undefined) ev.tool_response = ev.toolResult;
  for (const k of ['tool_input', 'tool_response']) if (k in ev) ev[k] = parse(ev[k]);
  const ti = ev.tool_input;
  if (typeof n === 'string' && TOOLS[n] && (ev.tool_name === 'Write' || ev.tool_name === 'Edit') && ti && typeof ti === 'object' && !ti.file_path) {
    const k = PATHS.find((x) => typeof ti[x] === 'string');
    if (k) ti.file_path = ti[k];
  }
  return ev;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const [target, ...rest] = process.argv.slice(2);
  const pre = target === 'governor-pre-tool-use.mjs' || (target === 'event' && rest[0] === 'pre-tool-use' && !rest.includes('--graph-only'));
  // A governor that cannot run must not be an allow: for the tool-gating hook
  // an unspawnable child is a deny, unreadable stdin is an ask.
  const answer = (decision, why) => {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision,
      permissionDecisionReason: `enforcer-governor:governor_error ${why}` } }));
    process.exit(0);
  };
  let ev = {}, bad = false;
  const raw = (() => { try { return readFileSync(0, 'utf8'); } catch { bad = true; return ''; } })();
  try { ev = normalize(JSON.parse(raw)); if (!ev || typeof ev !== 'object') throw 0; } catch { bad = true; ev = {}; }
  if (pre && bad) answer('ask', 'unreadable or empty hook input');
  process.env.ENFORCER_HARNESS = 'grok';
  const argv = target === 'hook' || target === 'event' ? [`${root}bin/enforcer`, target, ...rest] : [`${root}hooks/claude/${target}`];
  const r = spawnSync(process.execPath, argv, { input: JSON.stringify(ev), env: process.env, stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status === null || r.error) {
    process.stderr.write(`enforcer-governor: hook child did not run to completion (${r.error?.message || r.signal})\n`);
    if (pre) answer('deny', 'hook child did not run');
    process.exit(1);
  }
  process.exit(r.status);
}
