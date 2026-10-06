# Change fragments

One file per pull request that touches `enforcer/` without bumping the version: `changes/<slug>.md`, a single line in the changelog's voice (what changed, and the PR number if known). The release node (`npm run bump <version>`) folds every fragment into the new `## <version>` heading of CHANGELOG.md and deletes the fragments. Fragments exist so parallel PRs never conflict on CHANGELOG.md; CI's `version-bump` job requires either a bump or a fragment.
