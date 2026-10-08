// Shadow mode: what the capability rules WOULD have decided, while they are off.
//
// Decisioning is off by default (the governor reports data first), and a
// receipt that only ever says "allow, checks_off" says nothing about risk. So
// when rulesOn is false and shadow is on, the capability rules are evaluated
// anyway and their verdict rides on the receipt as `would`, while the hook
// still answers allow.
//
// What shadow mode must never do, and why this file is so small:
//   - consult the tenant policy (no network: nothing here imports central.mjs);
//   - read spend state (the capability rules are pure; economics is not run);
//   - evaluate the graph-worker rules (worker.mjs): those are off with rulesOn;
//   - fail loudly: any error is swallowed and the receipt simply has no `would`.
// When rulesOn is true there is no `would`: the real decision is the receipt.
import { evaluate as capability, resolveRules } from './capability.mjs';
import { decisionRecord } from './codes.mjs';

/**
 * @param ev   the event the gate judges ({ action, tool, input, worker? ... })
 * @param cfg  the effective config (rulesOn, shadow, rules)
 * @param [rules]  injected rule resolver, for tests
 * @returns {{decision, code, rule}|undefined}  undefined when shadow does not
 *   apply or the evaluation failed.
 */
export function shadow(ev, cfg = {}, { rules = resolveRules } = {}) {
  if (cfg.rulesOn !== false || cfg.shadow === false) return undefined;
  try {
    const v = capability(rules({ ...cfg, rulesOn: true }), ev);
    if (!v) return { decision: 'allow', code: 'no_rule_matched', rule: null };
    const { decision, code, rule } = decisionRecord(v);
    return { decision, code, rule };
  } catch {
    return undefined;
  }
}
