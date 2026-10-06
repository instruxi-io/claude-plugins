// Which model a node's worker runs on, and the per-node turn cap.
import { truthy } from './util.mjs';

export const TIER_MODEL = { mechanical: 'sonnet', standard: 'sonnet', deep: 'opus' };

/** Explicit data.model (or the claim card's model) wins; a user-set tier beats the
 *  dispatcher's --model cap; otherwise the cap, then the tier, then sonnet. */
export function modelFor(node, override = null) {
  const data = node.data || {};
  const explicit = data.model || node.model;
  if (explicit) return explicit;
  const tier = String(data.tier || node.tier || '').toLowerCase();
  if (data.tier_source === 'user' && Object.hasOwn(TIER_MODEL, tier)) return TIER_MODEL[tier];
  if (override) return override;
  return Object.hasOwn(TIER_MODEL, tier) ? TIER_MODEL[tier] : 'sonnet';
}

export function nodeMaxTurns(node) {
  const raw = (node.data || {}).max_turns;
  if (!truthy(raw)) return null;
  const v = Math.trunc(Number(raw));
  return Number.isFinite(v) && v > 0 ? v : null;
}
