# Release checklist

CI (`version-bump` job) fails a PR that changes `enforcer/` without a new version and a changelog entry, and fails a tag push whose tag differs from `enforcer/plugin.json`.

1. Move the `## Unreleased` notes in `CHANGELOG.md` under a new `## <version>` heading.
2. `npm run bump <version>` — edits all six manifests: `enforcer/plugin.json`, `enforcer/.claude-plugin/plugin.json`, `enforcer/package.json`, `kit.json`, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`.
3. `node --test test/version-identity.test.mjs` and `cd enforcer && npm test`.
4. Merge the PR to `main`.
5. Tag the merge commit (`git tag v<version>`) and publish the tag to origin. The tag check must pass.
6. Smoke: `claude plugin marketplace update instruxi && claude plugin update enforcer@instruxi`, then confirm `claude plugin list` shows `<version>`.

## Supply-chain pins

- Before tagging, set `ref` (a 40-char commit sha) on every github-source entry in `.claude-plugin/marketplace.json`; jev-hooks also carries `source.ref` (its tag) and `source.sha`. Check: `node -p "JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json','utf8')).plugins.filter(p=>p.source?.source==='github').every(p=>String(p.ref||'').length===40)"` prints `True`.
- Workflow `uses:` lines stay pinned to a 40-char sha with a version comment; `.github/dependabot.yml` proposes updates.
- Run `npm run sbom` and attach `dist/sbom.cdx.json` (CycloneDX) to the GitHub release.
- Repository ruleset (Settings > Rules): signed tags (`v*`) required and a reviewed PR before merging to `main`. Confirm it is active before every release.
