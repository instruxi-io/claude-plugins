// Command arguments arrive through the ENFORCER_ARGS environment variable, not
// through the shell: the slash-command docs assign `$ARGUMENTS` to it inside
// single quotes and the bin parses it here, so a path with spaces stays one
// argument and shell metacharacters are data.

/** Split a string like a shell would for words, quotes and backslashes, running nothing. */
export function splitArgs(s) {
  const out = [];
  let cur = '', has = false, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; has = true; }
    else if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c)) { if (has) { out.push(cur); cur = ''; has = false; } }
    else { cur += c; has = true; }
  }
  if (has) out.push(cur);
  return out;
}

/** The command's arguments: ENFORCER_ARGS when set (slash commands), else argv. */
export function commandArgs(argv = process.argv.slice(2), env = process.env) {
  return env.ENFORCER_ARGS !== undefined ? splitArgs(env.ENFORCER_ARGS) : argv;
}
