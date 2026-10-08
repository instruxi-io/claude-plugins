// Claude Code shim: hook JSON -> common event -> core decision -> Claude's
// permission vocabulary. The decision and its wording live in lib/decide.mjs.
// Fails closed: a throw denies (headless) or asks; bad stdin asks.
import { input, emit, pass, guardPre } from './lib.mjs';
import { decide } from '../lib/decide.mjs';

const EVENT = 'PreToolUse';
await guardPre(EVENT, async () => {
  const ev = input('PreToolUse');
  if (ev.badStdin || typeof ev.tool_name !== 'string')
    emit(EVENT, {
      permissionDecision: 'ask',
      permissionDecisionReason:
        'enforcer-governor:governor_error unreadable or empty hook input\nThe governor could not read this tool call, so it asks you to confirm it.',
    });
  const r = await decide(ev);
  try {
    process.stderr.write(r.line + '\n');
  } catch {}
  const top = r.notice ? { systemMessage: r.notice } : {};
  if (r.decision) {
    emit(
      EVENT,
      {
        permissionDecision: r.decision,
        permissionDecisionReason: r.reason,
        ...(r.updatedInput ? { updatedInput: r.updatedInput } : {}),
      },
      top,
    );
  }
  pass(EVENT, top);
});
