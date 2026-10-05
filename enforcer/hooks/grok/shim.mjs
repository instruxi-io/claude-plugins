// Grok Build shim: node shim.mjs <claude-shim.mjs | hook <event> [handler]>
// Grok's stdin already carries the common fields (hook_event_name, session_id,
// tool_name, tool_input ...). Only tool names differ: map them to the names the
// governor's rules and the graph hooks know, then hand over to the shared core.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOLS = { run_terminal_command: 'Bash', read_file: 'Read', search_replace: 'Edit', grep: 'Grep',
  list_dir: 'Glob', web_search: 'WebSearch', spawn_subagent: 'Task' };
export function normalize(ev) {
  const n = ev.tool_name;
  if (typeof n === 'string') ev.tool_name = TOOLS[n] || (n.includes('__') && !n.startsWith('mcp__') ? `mcp__${n}` : n);
  return ev;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  let ev = {};
  const raw = (() => { try { return readFileSync(0, 'utf8'); } catch { return ''; } })();
  try { ev = normalize(JSON.parse(raw || '{}')); } catch {}
  const [target, ...rest] = process.argv.slice(2);
  const argv = target === 'hook' ? [`${root}bin/enforcer`, 'hook', ...rest] : [`${root}hooks/claude/${target}`];
  const r = spawnSync(process.execPath, argv, { input: JSON.stringify(ev), stdio: ['pipe', 'inherit', 'inherit'] });
  process.exit(r.status ?? 0);
}
