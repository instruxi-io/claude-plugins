// What happens after a failed attempt: one remediation launch, then triage; and the triage gate's title.

export const TITLE_MAX = 120;

/** text cut to at most n chars at a word boundary (with an ellipsis). */
export function clipWords(text, n) {
  text = String(text).split(/\s+/).filter(Boolean).join(' ');
  if (text.length <= n) return text;
  const head = text.slice(0, n - 1);
  const i = head.lastIndexOf(' ');
  const cut = (i > 0 ? head.slice(0, i) : head) || head;
  return cut.replace(/[.,;:\- ]+$/, '') + '…';
}

/** 'remediate' (attempts left), 'triage' (spent), or 'person' (spent and triage is off or done). */
export function nextStep({ attempts, maxAttempts, noTriage = false, triaged = false }) {
  if (attempts < maxAttempts) return 'remediate';
  return noTriage || triaged ? 'person' : 'triage';
}

/** The gate node a triage `gate` decision creates: title within the server limit, allowlisted data. */
export function gateSpec(failed, tkey, t) {
  if (t.action !== 'gate') throw new Error('not a gate decision');
  return {
    key: `gate-${failed.key}`.slice(0, 80),
    type: 'gate',
    title: clipWords(t.decision, TITLE_MAX),
    description: `${t.decision}\n\nWhy (triage ${tkey}): ${t.reason}`,
    data: { created_by: 'triage', triage_of_key: failed.key, triage_reason: t.reason },
  };
}
