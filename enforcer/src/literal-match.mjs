// Quoted literals in acceptance lines write a tab as backslash-t; real output has a TAB. One helper for evidence-run and
// plan-check: try the raw literal first, then the literal with \t, \n and \\ decoded.

/** Decode the escapes \t, \n and \\ (a backslash and a letter) in a literal. */
export const decodeEscapes = (l) => l.replace(/\\([tn\\])/g, (_, c) => (c === 't' ? '\t' : c === 'n' ? '\n' : '\\'));

/** The forms to try, raw first. */
export const literalForms = (l) => {
  const d = decodeEscapes(l);
  return d === l ? [l] : [l, d];
};

/** True when the output contains the literal raw or decoded. */
export const literalIn = (out, l) => literalForms(l).some((f) => out.includes(f));

/** The first output line holding the literal (raw first, decoded second), or undefined. */
export function matchingLine(out, l) {
  for (const f of literalForms(l)) {
    const first = f.split('\n')[0];
    const hit = out.includes(f) ? out.split('\n').find((s) => s.includes(first)) : undefined;
    if (hit) return hit;
  }
  return undefined;
}
