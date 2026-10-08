// PostToolUse / PostToolUseFailure: append what the tool did to the run's evidence file.
import { actorKey } from '../state.mjs';
import { loadRun } from '../run.mjs';
import { appendEvidence, PR_RE } from '../evidence.mjs';
import { redact } from '../redact.mjs';
import { OUTPUT_CLIP, clipOutput } from '../clip.mjs';
import { isGraphTool, markAttested, isObj } from './common.mjs';

const EXCERPT_CLIP = 600,
  RAW_KEEP = 5 * 1024 * 1024;
const DELIVERY_CMD = /gh\s+pr\s+(create|view)\b|land-pr\.sh/;
const EXIT_LINE = /^(?:Error: )?Exit code (\d+)\s*/i;
const pyStr = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

export function normalize(resp) {
  if (Array.isArray(resp))
    return resp
      .filter((b) => isObj(b) && b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('\n');
  return resp;
}

export function bashRecord(ti, resp) {
  const cmd0 = (ti || {}).command || '';
  if (!cmd0) return null;
  let exit = 0,
    out = '';
  if (isObj(resp)) {
    const k = ['exit_code', 'exitCode', 'returnCode', 'code'].find((x) => Number.isInteger(resp[x]));
    exit = k ? resp[k] : resp.interrupted ? 130 : 0;
    out = resp.stdout || '';
    const err = resp.stderr || '';
    if (String(err).trim()) out = out ? `${out}\n${err}` : err;
  } else if (typeof resp === 'string') {
    const m = EXIT_LINE.exec(resp);
    if (m) {
      exit = Number(m[1]);
      out = resp.slice(m[0].length);
    } else if (resp.trimStart().toLowerCase().startsWith('error')) {
      exit = 1;
      out = resp;
    } else out = resp;
  }
  const [cmd, nc] = redact(cmd0);
  const [o, no] = redact(out);
  const rec = { kind: 'command', cmd: cmd.slice(0, OUTPUT_CLIP), exit, output: clipOutput(o) };
  if (nc + no) rec.redactions = nc + no;
  if (o.length > OUTPUT_CLIP) rec.raw = clipOutput(o, RAW_KEEP);
  return rec;
}

export function fileRecord(name, ti0) {
  const ti = ti0 || {};
  const path = ti.file_path || ti.path || ti.notebook_path || '';
  if (!path) return null;
  let ex;
  if (name === 'Write') ex = ti.content || '';
  else if (name === 'MultiEdit')
    ex = Array.isArray(ti.edits)
      ? ti.edits
          .filter(isObj)
          .map((e) => String(e.new_string || ''))
          .join('\n')
      : '';
  else ex = ti.new_string || ti.new_source || ti.content || '';
  const [e, n] = redact(pyStr(ex));
  const rec = { kind: 'file', path, excerpt: e.slice(0, EXCERPT_CLIP) };
  if (n) rec.redactions = n;
  return rec;
}

export async function captureEvidence(inp) {
  try {
    const name = inp.tool_name || '';
    const captured = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name);
    if (!captured && (!name.startsWith('mcp__') || isGraphTool(name))) return null;
    const sid = actorKey(inp);
    markAttested(sid, inp.session_id);
    const run = loadRun(sid);
    if (!run) return null;
    const rid = run.run_id;
    let resp = normalize(inp.tool_response);
    if (inp.hook_event_name === 'PostToolUseFailure' || ((resp === undefined || resp === null) && 'error' in inp)) {
      const err = pyStr(inp.error);
      resp = EXIT_LINE.test(err) || inp.is_interrupt ? err : 'Error: Exit code 1\n' + err;
      if (inp.is_interrupt && !EXIT_LINE.test(err)) resp = 'Error: Exit code 130\n' + err;
    }
    let rec = null;
    if (captured) rec = name === 'Bash' ? bashRecord(inp.tool_input, resp) : fileRecord(name, inp.tool_input);
    if (rec) {
      rec._run = rid;
      appendEvidence(sid, rec);
    }
    if (name === 'Bash' && rec && DELIVERY_CMD.test(String(rec.cmd || ''))) {
      const g = new RegExp(PR_RE.source, 'g');
      for (const url of new Set(rec.output.match(g) || [])) appendEvidence(sid, { kind: 'artifact', url, label: 'pull request URL in tool output', _run: rid });
    }
  } catch {}
  return null;
}
