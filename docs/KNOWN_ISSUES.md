# Known issues and limits

What we know is imperfect, stated plainly. Last reviewed 2026-10-08, against plugin 1.3.x.

## Security and data

- **Governor decisioning is off by default.** It records and reports; it only
  blocks once you turn rules on. An unreadable config therefore fails open to
  "report only". The 1.3.1 hardening work makes the organisation floor
  fail closed (tracked in the hardening graph).
- **Worker credentials.** Dispatched workers act as a named agent account with
  its own expiring key. A worker's environment holds that key for the length of
  its run; a SIGKILL can leave a key file behind in the state directory until the
  next prune. Workers share the operator's `HOME`; per-worker home isolation was
  rejected because copying Claude's single-use refresh token would sign the
  operator out.
- **Telemetry.** Off unless enabled. When enabled it can include tool-call
  metadata; review the collector config before turning it on.
- **Secrets scanning.** One-time scans of about 17,000 commits across seven
  repositories found no live secrets. There is no continuous scanner yet.

## Platform

- **Windows.** MCP, files, the governor and the graph hooks work. `enforcer
  dispatch` is POSIX only (use WSL).
- **Go toolchain.** The enforcer-graph service still builds on a Go release with
  known standard-library advisories; the demos viewer has been patched. The bump
  needs the service's test database and is scheduled.
- **Graph import.** `POST /graphs/import` with node `resources` can report a
  false `edge_would_create_cycle`. Workaround: import without resources, then
  PATCH each node's data.
- **MCP tool list after reconnect.** Agent tools can be missing from the list
  after `/mcp` reconnects until the session restarts.
- **Verdict variance.** The judge is not fully deterministic near its
  thresholds; about 1 run in 24 needs a tie-break by a human.

## Process

- **Review.** Branch protection blocks force-push and deletion on every repo and
  requires CI checks on claude-plugins. Required human review is not enabled
  yet.
- **Dependencies.** Dependabot and SHA-pinned actions are in place on
  claude-plugins; rolled out to the other repositories in October 2026.
- **jev-hooks** is a separate, community project (MIT) that needs your own
  TypeSafe key. Whether distributing a client driven by users' own keys fits
  TypeSafe's agreement is still unconfirmed with them.
- **Licence.** FSL-1.1-ALv2; no lawyer has reviewed the choice yet.
