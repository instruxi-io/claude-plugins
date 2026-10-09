// Node keys and data.repo values reach paths and branch names: one validator, used by every function that builds one.
export const SAFE_IDENT = /^[A-Za-z0-9._-]+$/;

/** True for a string of letters, digits, . _ - that is not `.` or `..`. */
export const safeIdent = (x) => typeof x === 'string' && SAFE_IDENT.test(x) && x !== '.' && x !== '..';

export const pyRepr = (x) => (typeof x === 'string' ? "'" + x.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'" : String(x));

/** Why a node's key or data.repo may not reach a path or branch name, or ''. */
export function unsafeIdent(node) {
  if (!safeIdent(node?.key)) return `key ${pyRepr(node?.key)} does not match ^[A-Za-z0-9._-]+$`;
  const repo = (node.data || {}).repo;
  if (repo !== undefined && repo !== null && !safeIdent(repo)) return `data.repo ${pyRepr(repo)} does not match ^[A-Za-z0-9._-]+$`;
  return '';
}

/** Throw when `value` (a node key or repo name, named `what`) is not a safe identifier. */
export function assertIdent(value, what = 'key') {
  if (!safeIdent(value)) throw new Error(`${what} ${pyRepr(value)} does not match ^[A-Za-z0-9._-]+$`);
  return value;
}

/** Throw when a node's key or data.repo is unsafe. */
export function assertNodeIdent(node) {
  const bad = unsafeIdent(node);
  if (bad) throw new Error(bad);
}
