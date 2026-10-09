// Read-only summary of the governor's local data: cost-<session>.json files and
// the receipts file. No network, no writes, no command text: a receipt's
// `reason` and `summary` are never read, only counts, codes and names.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ruleCode } from './codes.mjs';
import { isOn, isOff } from './bool.mjs';

const UNIT = { h: 3600e3, d: 86400e3 };
export function parseSince(s) {
  const m = /^(\d+)([hd])$/.exec(String(s || '24h'));
  if (!m) throw new Error(`--since takes 24h, 7d or 30d (got ${s})`);
  return +m[1] * UNIT[m[2]];
}

const readJSON = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const add = (o, k, n) => {
  o[k] = (o[k] || 0) + n;
};
const round = (n) => Math.round(n * 1e6) / 1e6;
const top = (o, n = 10) =>
  Object.entries(o)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));

function readReceipts(dir) {
  let text = '';
  try {
    text = readFileSync(join(dir, 'receipts.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn line is skipped */
    }
  }
  return out;
}

function decisionCode(r, checksOff) {
  if (typeof r.code === 'string') return r.code;
  if (r.verdict === 'allow') {
    if (r.unchecked) return 'spend_unchecked';
    return checksOff ? 'checks_off' : 'no_rule_matched';
  }
  if (r.source === 'policy') return 'tenant_policy';
  if (r.rule) return ruleCode({ id: r.rule });
  return r.source === 'capability' ? 'custom_rule' : 'spend_limit';
}

/** The report as one plain object. `dir` is the governor state dir. */
export function buildReport(dir, { since = '24h', now = Date.now(), verbose = false } = {}) {
  const from = now - parseSince(since);
  const receipts = readReceipts(dir).filter((r) => Date.parse(r.ts) >= from);
  const cfg = readJSON(join(dir, 'config.json')) || {};
  const checksOff = !isOn(cfg.budgetOn);

  // Session -> project, from the receipts that name one (agent ids are `<harness>:<session>`).
  const projectOf = {};
  for (const r of readReceipts(dir)) if (r.client && r.agent) projectOf[String(r.agent).split(':').pop()] = r.client;

  const perAgent = {},
    perProject = {},
    perModel = {};
  let spend = 0,
    tokens = 0;
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^cost-.+\.json$/.test(f));
  } catch {
    /* no state dir */
  }
  for (const f of files) {
    const d = readJSON(join(dir, f));
    if (!d || typeof d.usd !== 'number' || !(d.usd >= 0)) continue;
    let at = d.at;
    if (typeof at !== 'number') {
      try {
        at = statSync(join(dir, f)).mtimeMs;
      } catch {
        continue;
      }
    }
    if (at < from || at > now + 60e3) continue;
    const session = f.slice(5, -5);
    spend += d.usd;
    add(perAgent, session, d.usd);
    add(perProject, projectOf[session] || '(unknown)', d.usd);
  }
  const byTool = {},
    errByTool = {},
    byDecision = {},
    byCode = {},
    wouldByRule = {};
  let wouldDeny = 0,
    wouldAsk = 0;
  for (const r of receipts) {
    if (r.verdict === 'summary') {
      tokens += Number(r.tokens) || 0;
      if (r.model && typeof r.cost_usd === 'number') add(perModel, r.model, r.cost_usd);
      continue;
    }
    const tool = String(r.tool || '(none)');
    add(byTool, tool, 1);
    if (r.verdict === 'deny' || r.unchecked) add(errByTool, tool, 1);
    const dec = r.verdict === 'rewrite' ? 'rewrite' : String(r.verdict || 'unknown');
    add(byDecision, dec, 1);
    add(byCode, `${dec}:${decisionCode(r, checksOff)}`, 1);
    if (r.would && r.would.decision && r.would.decision !== 'allow') {
      if (r.would.decision === 'deny') wouldDeny++;
      else wouldAsk++;
      add(wouldByRule, `${r.would.decision}:${r.would.code || 'unknown'}`, 1);
    }
  }
  const rounded = (o) =>
    Object.fromEntries(
      Object.entries(o)
        .sort()
        .map(([k, v]) => [k, round(v)]),
    );
  const rep = {
    window: since,
    receipts: receipts.length,
    spend_usd: round(spend),
    tokens,
    spend_by_agent: rounded(perAgent),
    spend_by_project: rounded(perProject),
    spend_by_model: rounded(perModel),
    top_tools_by_calls: top(byTool),
    top_tools_by_errors: top(errByTool),
    decisions: Object.fromEntries(Object.entries(byDecision).sort()),
    decision_codes: Object.fromEntries(Object.entries(byCode).sort()),
    would: { deny: wouldDeny, ask: wouldAsk, by_rule: Object.fromEntries(Object.entries(wouldByRule).sort()) },
  };
  if (verbose) {
    // Rule ids and tool names only; never the reason or summary text.
    const rules = {};
    for (const r of receipts) if (r.rule && r.verdict !== 'summary') add(rules, `${r.verdict}:${r.rule}:${r.tool || '(none)'}`, 1);
    rep.decision_rules = Object.fromEntries(Object.entries(rules).sort());
  }
  return rep;
}

const usd = (n) => '$' + n.toFixed(2);
const section = (title, obj, fmt = (v) => String(v)) => {
  const rows = Object.entries(obj);
  return [`\n${title}`, ...(rows.length ? rows.map(([k, v]) => `  ${k}  ${fmt(v)}`) : ['  none'])];
};
const listSection = (title, arr) => [`\n${title}`, ...(arr.length ? arr.map((t) => `  ${t.name}  ${t.count}`) : ['  none'])];

export function formatReport(rep) {
  return [
    `Governor report, last ${rep.window}`,
    `Total spend: ${usd(rep.spend_usd)}   Tokens: ${rep.tokens}   Receipts: ${rep.receipts}`,
    ...section('Spend per agent', rep.spend_by_agent, usd),
    ...section('Spend per project', rep.spend_by_project, usd),
    ...section('Spend per model', rep.spend_by_model, usd),
    ...listSection('Top tools by calls', rep.top_tools_by_calls),
    ...listSection('Top tools by errors', rep.top_tools_by_errors),
    ...section('Decisions', rep.decisions),
    ...section('Decision codes', rep.decision_codes),
    `\nWould-have (decisioning off): ${rep.would.deny} deny, ${rep.would.ask} ask`,
    ...Object.entries(rep.would.by_rule).map(([k, v]) => `  ${k}  ${v}`),
    ...(rep.decision_rules ? section('Rules (verbose)', rep.decision_rules) : []),
  ].join('\n');
}
