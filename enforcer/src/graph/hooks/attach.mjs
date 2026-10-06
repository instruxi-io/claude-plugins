// PreToolUse on graph_next_work / graph_heartbeat / graph_report / graph_remember.
// Stamps `client`, attaches captured evidence and usage, gates succeeded reports on the card's evidence hints.
// A hook cannot edit the model's arguments; it returns the whole argument object through updatedInput.
// Fails open: nothing captured, no data dir, garbage input -> no output.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { actorKey, stateBase } from '../state.mjs';
import { loadRun } from '../run.mjs';
import { loadEvidence, stripInternal, selectEvidence, mergeEvidence, EVIDENCE_CAP } from '../evidence.mjs';
import { redact } from '../redact.mjs';
import { OUTPUT_CLIP } from '../clip.mjs';
import { apiFetch } from '../../../lib/api/client.mjs';
import { authHeaders } from '../../credentials.mjs';
import { findConfig, isGraphTool, isObj, actorTranscript, transcriptUsage, typedUsage } from './common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const pluginVersion = () => {
  try { return String(JSON.parse(readFileSync(join(here, '../../../plugin.json'), 'utf8')).version || 'unknown'); } catch { return 'unknown'; }
};
export const CLIENT_BASE = () => `enforcer-graph-plugin/${pluginVersion()}`;
const CLIENT_TOOLS = ['graph_next_work', 'graph_heartbeat', 'graph_report'];
const REMEMBER_RECENT = 3;
const UPLOAD_BUDGET_MS = 10_000;
const PR_URL = /https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const mode = () => (process.env.GRAPH_EVIDENCE_MODE || 'input').trim().toLowerCase();

const NOTE = (n) => `enforcer-graph: ${n} evidence item(s) captured from your own tool results were attached to this report. Do not hand-write evidence.`;
const HANDOFF = (js) => 'enforcer-graph: this harness cannot rewrite an MCP tool\'s arguments, so pass the following captured evidence as the `evidence` argument of graph_report VERBATIM - do not edit, summarise, reorder or add to it. It was captured from your own tool results while the run was open.\n\n' + js;

export const stampsClient = (tool) => isGraphTool(tool) && CLIENT_TOOLS.some((t) => String(tool).endsWith(t));

/** Client attestation: hooks=on only once a capture or the self-check left a marker for this actor/session. */
export function clientFor(inp) {
  inp = inp || {};
  const keys = [actorKey(inp), inp.session_id].filter(Boolean);
  const ok = keys.some((k) => existsSync(join(stateBase(), 'attest', String(k))));
  return ok ? `${CLIENT_BASE()}; hooks=on` : `${CLIENT_BASE()}; hooks=off:no-capture-yet`;
}
export const withClient = (args, inp) => ({ ...(isObj(args) ? args : {}), client: clientFor(inp) });

/** Resolve a claimed PR with gh; an unresolvable PR is a finding, any other failure returns null. */
export function checkPr(url, run = defaultGh) {
  const m = PR_URL.exec(url || '');
  if (!m) return null;
  const [, owner, repo, num] = m;
  const r = run(['pr', 'view', num, '-R', `${owner}/${repo}`, '--json', 'state,title,mergedAt,url']);
  if (!r) return null;
  if (r.status !== 0) {
    const err = String(r.stderr || '').trim().split('\n').filter(Boolean);
    if (!err.length) return null;
    return { kind: 'artifact', url, label: 'pull request NOT FOUND', output: `gh pr view ${num} -R ${owner}/${repo} -> ${err[err.length - 1].slice(0, 200)}` };
  }
  let d; try { d = JSON.parse(r.stdout); } catch { return null; }
  return { kind: 'artifact', url: d.url || url, label: `pull request ${String(d.state || '?').toLowerCase()}: ${String(d.title || '').slice(0, 120)}`,
    output: `gh pr view ${num} -R ${owner}/${repo} -> state=${d.state} merged=${d.mergedAt || 'no'}` };
}
function defaultGh(args) {
  try { const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 10_000 }); return r.error ? null : r; } catch { return null; }
}

export function withUsage(args, usage, legacy = true) {
  args = isObj(args) ? { ...args } : {};
  if (legacy) args.data = { ...(isObj(args.data) ? args.data : {}), usage };
  const typed = typedUsage(usage);
  if (typed && !isObj(args.usage)) args.usage = typed;
  return args;
}

export function overrideEntries(ov) {
  const out = [];
  for (const e of Array.isArray(ov) ? ov : [ov]) {
    if (!isObj(e) || !Number.isInteger(e.line)) return null;
    out.push({ line: e.line, reason: String(e.reason || '') });
  }
  return out.length ? out : null;
}

export function evidenceGaps(hints, evidence) {
  const recs = (evidence || []).filter(isObj);
  const cmds = recs.filter((e) => e.kind === 'command');
  const text = (e) => ['cmd', 'output', 'url', 'label', 'excerpt', 'path'].map((k) => String(e[k] || '')).join(' ').toLowerCase();
  const hasPr = recs.some((e) => { const t = text(e); return (t.includes('land-pr') && t.includes('merge')) || t.includes('pull request merged') || (t.includes('merged=') && !t.includes('merged=no')); });
  const hasFile = recs.some((e) => e.kind === 'file' || /^(cat |sed -n|head |tail )/.test(String(e.cmd || '').trimStart()));
  const gaps = [];
  (hints || []).forEach((h, i) => {
    if (!isObj(h)) return;
    const n = i + 1, crit = String(h.criterion || '').slice(0, 80);
    if (h.kind === 'pr' && !hasPr) gaps.push([n, crit, 'wants land-pr.sh\'s merged output; attach the command that ran land-pr.sh']);
    else if (h.kind === 'file' && !hasFile) gaps.push([n, crit, 'wants the file body; attach `cat <file>` (or a Read/Edit of it), not a listing or diff stat']);
    else if ((h.kind === 'check' || h.kind === 'prose') && !cmds.length) gaps.push([n, crit, 'wants a command whose verbatim output shows it; run the deciding command and attach it']);
  });
  return gaps;
}

const deny = (why) => ({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'enforcer-graph: ' + why });

export function evidenceBlock(inp, evidence) {
  const ti = inp.tool_input || {};
  if (ti.status !== 'succeeded') return null;
  const gaps = evidenceGaps((loadRun(actorKey(inp)) || {}).acceptance_evidence, evidence);
  if (!gaps.length) return null;
  const ov = ti.evidence_override;
  if (ov) {
    const entries = overrideEntries(ov);
    const unmet = gaps.map((g) => g[0]).sort((a, b) => a - b);
    if (!entries) return deny(`evidence_override must be {line: <acceptance line index>, reason: ...} (or a list of them); a bare true or a missing line is refused. Unmet lines: [${unmet.join(', ')}]`);
    if (entries.some((e) => !e.reason.trim())) return deny('evidence_override needs a reason for every line.');
    const have = new Set(entries.map((e) => e.line));
    const missing = unmet.filter((n) => !have.has(n));
    if (missing.length) return deny(`evidence_override does not cover unmet lines [${missing.join(', ')}].`);
    return null;
  }
  const msg = gaps.map(([n, c, fix]) => `criterion ${n} (${c}) ${fix}`).join('; ');
  return deny('report blocked, the evidence misses what the card\'s hints ask for: ' + msg + '. Run it, then report again; or pass evidence_override: {line: <index>, reason: ...}.');
}

// ---- enforcer-files upload of output longer than the clip ----
export const filesBaseUrl = (cfg) => String(process.env.GRAPH_FILES_BASE_URL || (cfg || {}).files_base_url || '').trim().replace(/\/+$/, '');
const providerCache = new Map();

async function authFor(cfg) {
  if (cfg && cfg.api_key) return { 'X-API-Key': cfg.api_key };
  return authHeaders();
}
const freq = (url, init, auth, ms) => apiFetch(url, { ...init, headers: { ...auth, Accept: 'application/json', ...(init.headers || {}) } }, { timeoutMs: ms, retries: 0 });

export async function uploadFullOutput(text, cfg, timeoutMs = UPLOAD_BUDGET_MS) {
  try {
    const base = filesBaseUrl(cfg);
    if (!base || timeoutMs <= 0) return null;
    const auth = await authFor(cfg);
    if (!Object.keys(auth).length) return null;
    let prov = providerCache.get(base);
    if (!prov) {
      const r = await freq(base + '/storage/provider', {}, auth, timeoutMs);
      const d = r.ok ? await r.json() : null;
      prov = d && d.configured ? d.provider : null;
      if (typeof prov !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(prov)) return null;
      providerCache.set(base, prov);
    }
    const name = `graph-evidence/${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}-${randomUUID().replace(/-/g, '').slice(0, 12)}.log`;
    const form = new FormData();
    form.append('file', new Blob([redact(text)[0]], { type: 'text/plain; charset=utf-8' }), name.split('/').pop());
    form.append('file_name', name);
    const r = await freq(`${base}/storage/file/${prov}/upload`, { method: 'POST', body: form }, auth, timeoutMs);
    const d = r.ok ? await r.json() : null;
    const fid = d && d.data && d.data.file_id;
    if (typeof fid === 'string' && UUID_RE.test(fid.trim())) return fid.trim().toLowerCase();
  } catch {}
  return null;
}

/** Upload each item's `raw`; `raw` is always removed so it never reaches the report. */
export async function attachFiles(items, cfg, upload = uploadFullOutput) {
  const deadline = Date.now() + UPLOAD_BUDGET_MS;
  const enabled = !!filesBaseUrl(cfg) && cfg != null;
  for (const it of items) {
    if (!isObj(it) || !('raw' in it)) continue;
    const raw = it.raw; delete it.raw;
    if (!enabled || typeof raw !== 'string' || raw.length <= OUTPUT_CLIP) continue;
    const fid = await upload(raw, cfg, deadline - Date.now());
    if (fid) { it.file = fid; it.file_bytes = Buffer.byteLength(raw); }
  }
  return items;
}

export async function decide(inp, deps = {}) {
  const tool = inp.tool_name || '';
  const isReport = tool.endsWith('graph_report'), isRemember = tool.endsWith('graph_remember'), isHeartbeat = tool.endsWith('graph_heartbeat');
  if (!(isReport || isRemember || isHeartbeat)) return null;
  const sid = actorKey(inp);
  const run = loadRun(sid) || {};
  const records = loadEvidence(sid, run.run_id);
  let usage = null;
  if (isHeartbeat) {
    usage = transcriptUsage(actorTranscript(inp), run.claimed_at);
    return usage && mode() !== 'context' ? { hookEventName: 'PreToolUse', updatedInput: withUsage(inp.tool_input, usage, false) } : null;
  }
  if (isReport) usage = transcriptUsage(actorTranscript(inp), run.claimed_at);
  if (!records.length) return usage && mode() !== 'context' ? { hookEventName: 'PreToolUse', updatedInput: withUsage(inp.tool_input, usage) } : null;
  let evidence = isRemember
    ? selectEvidence(records.slice(-REMEMBER_RECENT).map(stripInternal), REMEMBER_RECENT)
    : selectEvidence(records.map(stripInternal));
  // A claimed PR is the one externally checkable claim: resolve it with gh, never trust the URL.
  const pr = isReport ? (inp.tool_input || {}).pr : null;
  const checked = typeof pr === 'string' && pr.trim() ? checkPr(pr, deps.gh) : null;
  if (checked) {
    evidence = evidence.filter((e) => !(e.kind === 'artifact' && e.url === checked.url && !String(e.label).includes('NOT FOUND')));
    evidence = [...evidence, checked];
  }
  if (isReport) evidence = mergeEvidence(evidence, (inp.tool_input || {}).evidence, EVIDENCE_CAP);
  // Decide BEFORE any upload: a denied report must leave no files behind.
  if (isReport) {
    const blocked = evidenceBlock(inp, evidence);
    if (blocked) return blocked;
    const ov = (inp.tool_input || {}).evidence_override;
    const entries = ov ? overrideEntries(ov) : null;
    if (entries) {
      const ti = { ...inp.tool_input }; delete ti.evidence_override;
      ti.data = { ...(isObj(ti.data) ? ti.data : {}), overrides: entries };
      inp = { ...inp, tool_input: ti };
    }
  }
  let cfg = null;
  try { cfg = findConfig(inp.cwd); } catch {}
  try { evidence = await attachFiles(evidence, cfg, deps.upload); } catch { for (const it of evidence) if (isObj(it)) delete it.raw; }
  const out = { hookEventName: 'PreToolUse' };
  if (mode() === 'context') out.additionalContext = HANDOFF(JSON.stringify(evidence));
  else {
    const a = usage ? withUsage(inp.tool_input, usage) : inp.tool_input;
    out.updatedInput = { ...(isObj(a) ? a : {}), evidence };
    out.additionalContext = NOTE(evidence.length);
  }
  return out;
}

export function reclaimedNotice(inp) {
  const run = loadRun(actorKey(inp));
  return run && run.reclaimed
    ? `enforcer-graph: the lease on node ${run.key || run.node_id} was reclaimed (the heartbeat got 404/409). Stop; a report from this run will be refused. graph_remember any progress worth keeping, then graph_next_work.` : null;
}

/** The PreToolUse answer ({hookSpecificOutput, systemMessage?}) or null. Never throws. */
export async function attachEvidence(inp, deps) {
  try {
    if (!isObj(inp)) return null;
    const tool = inp.tool_name || '';
    let out = null;
    try { out = await decide(inp, deps); } catch {}
    if (stampsClient(tool) && mode() !== 'context') {
      out = out || { hookEventName: 'PreToolUse' };
      out.updatedInput = withClient(out.updatedInput ?? inp.tool_input, inp);
    }
    const notice = isGraphTool(tool) ? reclaimedNotice(inp) : null;
    if (notice) { out = out || { hookEventName: 'PreToolUse' }; out.additionalContext = ((out.additionalContext || '') + '\n' + notice).trim(); }
    if (!out) return null;
    return notice ? { hookSpecificOutput: out, systemMessage: notice } : { hookSpecificOutput: out };
  } catch { return null; }
}
