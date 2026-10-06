#!/usr/bin/env node
// npm run sync:spec — fetch each source at the ref pinned in spec.lock.json,
// convert Swagger 2 to OpenAPI 3 (convert.mjs), write spec/<name>.json and
// refresh the lock's sha256. The ref does not move unless asked:
//   --bump   re-pin every source to its default branch head, then sync
// Sources are read with `git show <ref>:<path>` from a sibling checkout
// (../<repo>, or $SPEC_REPOS_DIR/<repo>), falling back to `gh api`.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { swagger2ToOpenapi3 } from './convert.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LOCK = resolve(here, 'spec.lock.json');
const MAX = 64 * 1024 * 1024;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
const bump = process.argv.includes('--bump');
const reposDir = process.env.SPEC_REPOS_DIR || resolve(here, '../../../..');

function local(repo) {
  const d = resolve(reposDir, repo);
  return existsSync(resolve(d, '.git')) ? d : null;
}
function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: MAX, stdio: ['ignore', 'pipe', 'ignore'] });
}
function headOf(repo) {
  const d = local(repo);
  if (d) {
    const ref = git(d, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim();
    return git(d, ['rev-parse', ref]).trim();
  }
  const b = JSON.parse(execFileSync('gh', ['api', `repos/instruxi-io/${repo}`], { encoding: 'utf8' })).default_branch;
  return execFileSync('gh', ['api', `repos/instruxi-io/${repo}/commits/${b}`, '--jq', '.sha'], { encoding: 'utf8' }).trim();
}
function fetchAt(repo, ref, path) {
  const d = local(repo);
  if (d) { try { return git(d, ['show', `${ref}:${path}`]); } catch { /* fall through to gh */ } }
  return execFileSync('gh', ['api', `repos/instruxi-io/${repo}/contents/${path}?ref=${ref}`, '-H', 'Accept: application/vnd.github.raw'], { encoding: 'utf8', maxBuffer: MAX });
}

mkdirSync(resolve(here, 'spec'), { recursive: true });
for (const [name, src] of Object.entries(lock.sources)) {
  if (bump) src.ref = headOf(src.repo);
  const raw = fetchAt(src.repo, src.ref, src.path);
  const json = JSON.parse(raw);
  const out = src.kind === 'swagger2' ? swagger2ToOpenapi3(json) : json;
  const body = JSON.stringify(out, null, 2) + '\n';
  writeFileSync(resolve(here, src.file), body);
  src.upstream_sha256 = sha256(raw);
  src.sha256 = sha256(body);
  console.log(`sync-spec: ${name} @ ${src.ref.slice(0, 10)} -> ${src.file}`);
}
writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
