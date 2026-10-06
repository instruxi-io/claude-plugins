// Which nodes the dispatcher launches: resource contention, merge targets, warm-session affinity.
import { parseTs } from './util.mjs';

/** [pr, repoSlug] for a merge node that names a PR, else null. */
export function mergeTarget(node) {
  if (node.type !== 'merge') return null;
  const data = node.data || {};
  const pr = data.pr || data.pr_url || data.branch;
  if (!pr) return null;
  const s = String(pr);
  let m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(s);
  if (m) return [m[2], m[1]];
  m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (m) return [m[2], m[1]];
  return [s, null];
}

export function repoOf(node) {
  return (node.data || {}).repo || null;
}

export function resourcesOf(node) {
  let r = (node.data || {}).resources || [];
  if (typeof r === 'string') r = [r];
  const out = new Set((Array.isArray(r) ? r : []).filter(Boolean).map(String));
  const mt = mergeTarget(node);
  if (mt) out.add('land:' + String((node.data || {}).repo || mt[1] || '?')); // one land-pr per repo at a time
  return out;
}

/** A running node whose lease has expired. `now` is epoch ms. */
export function lapsed(node, now = Date.now()) {
  if (node.status !== 'running') return false;
  const exp = parseTs(node.lease_expires_at);
  return exp !== null && exp < now;
}

function hasKey(busy, key) {
  if (!busy) return false;
  if (busy instanceof Set || busy instanceof Map) return busy.has(key);
  if (Array.isArray(busy)) return busy.includes(key);
  return Object.hasOwn(busy, key);
}

/** Pick up to `slots` candidates in order, never two on one resource value.
 *  Returns {chosen, skipped} with skipped as [node, reason] pairs. */
export function select(candidates, held, slots, busyKeys = []) {
  const heldSet = new Set(held);
  const chosen = [];
  const skipped = [];
  for (const n of candidates) {
    if (hasKey(busyKeys, n.key)) continue;
    const r = resourcesOf(n);
    const clash = [...r].filter((x) => heldSet.has(x)).sort();
    if (clash.length) {
      skipped.push([n, 'resource held: ' + clash.join(', ')]);
      continue;
    }
    if (chosen.length >= slots) {
      skipped.push([n, 'no free worker slot']);
      continue;
    }
    chosen.push(n);
    for (const x of r) heldSet.add(x);
  }
  return { chosen, skipped };
}

/** [ok, whyNot]. `born` and `now` are epoch seconds. */
export function sessionUsable(sess, maxNodes, maxAgeS, now = Date.now() / 1000) {
  if (sess.nodes >= maxNodes) return [false, `${sess.nodes} node(s), cap ${maxNodes}`];
  const age = now - sess.born;
  if (age >= maxAgeS) return [false, `${Math.floor(age / 60)}m old, cap ${Math.floor(maxAgeS / 60)}m`];
  return [true, ''];
}

/** Stable reorder: a node whose (repo, model) has an idle warm session goes first, as many per
 *  pair as there are sessions. `warm` maps "repo\u0000model" (see warmKey) -> idle count. */
export const warmKey = (repo, model) => repo + '\u0000' + model;

export function affinityOrder(candidates, warm, modelOf) {
  const left = new Map(warm instanceof Map ? warm : Object.entries(warm || {}));
  const first = [];
  const rest = [];
  for (const n of candidates) {
    const repo = repoOf(n);
    const k = repo ? warmKey(repo, modelOf(n)) : null;
    if (k && (left.get(k) || 0) > 0 && !mergeTarget(n)) {
      left.set(k, left.get(k) - 1);
      first.push(n);
    } else rest.push(n);
  }
  return [...first, ...rest];
}
