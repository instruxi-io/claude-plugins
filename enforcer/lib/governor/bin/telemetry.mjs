#!/usr/bin/env node
// /enforcer-governor:telemetry [on | off | status]
import { enable, disable, status } from '../adapters/claude-code/telemetry.mjs';
import { loadConfig } from '../src/store.mjs';
import { DEFAULTS } from '../src/policy.mjs';
import { stats } from '../src/outbox.mjs';
import { isFederated } from '../src/credentials.mjs';

const cmd = (process.argv[2] || 'status').trim();
const cfg = { ...DEFAULTS, ...loadConfig() };
const out = (s) => process.stdout.write(s + '\n');

try {
  if (cmd === 'on') {
    const r = enable(cfg);
    out(`Telemetry on. Claude Code will export its metrics and events to ${r.endpoint}.`);
    out(`Authenticated with your Enforcer sign-in through otelHeadersHelper (${r.helper}); no credential is written to settings.`);
    if (r.removed.length) out(`Removed ${r.removed.join(' and ')} from ${r.settings}: they would export prompt text or tool parameters.`);
    out('Prompt text is not exported. Restart Claude Code to start exporting.');
    if (!isFederated()) out('You are not signed in, so exports will be refused until you run /enforcer-governor:login.');
  } else if (cmd === 'off') {
    const r = disable();
    out(`Telemetry off. Removed the export settings from ${r.settings}; restart Claude Code to stop exporting.`);
  } else if (cmd === 'status') {
    const t = status();
    const q = stats();
    if (t.sensitive?.length)
      out(
        `Warning: ${t.sensitive.join(' and ')} ${t.sensitive.length > 1 ? 'are' : 'is'} set in Claude Code settings, so prompt text or tool parameters are exported. Run /enforcer-governor:telemetry on to remove ${t.sensitive.length > 1 ? 'them' : 'it'}.`,
      );
    out(t.on ? `Claude Code telemetry: on, exporting to ${t.endpoint}.` : 'Claude Code telemetry: off. Turn it on with /enforcer-governor:telemetry on.');
    out(
      cfg.shipOn === false
        ? 'Receipt shipping: off (shipOn).'
        : `Receipt shipping: on. ${q.behind ? `${q.unshippedBytes} bytes waiting` : 'caught up'}${q.shippedAt ? `, last shipped ${new Date(q.shippedAt).toISOString()}` : ', nothing shipped yet'}${q.lastError ? `. Last problem: ${q.lastError.message}` : ''}.`,
    );
  } else {
    out('Usage: /enforcer-governor:telemetry [on | off | status]');
  }
} catch (e) {
  out(`Not changed: ${e.message}`);
}
