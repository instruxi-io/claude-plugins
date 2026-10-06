// Shared by `npm run bump` and the CI version-bump job.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The six manifests that carry the enforcer version. `pick` finds the object holding it.
export const MANIFESTS = [
  { file: "enforcer/plugin.json", pick: (j) => j },
  { file: "enforcer/.claude-plugin/plugin.json", pick: (j) => j },
  { file: "enforcer/package.json", pick: (j) => j },
  { file: "kit.json", pick: (j) => j },
  { file: ".claude-plugin/marketplace.json", pick: (j) => j.plugins.find((p) => p.name === "enforcer") },
  { file: ".agents/plugins/marketplace.json", pick: (j) => j.plugins.find((p) => p.name === "enforcer") },
];

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function readVersions(root = ".") {
  return MANIFESTS.map((m) => ({
    file: m.file,
    version: m.pick(JSON.parse(fs.readFileSync(path.join(root, m.file), "utf8"))).version,
  }));
}

export function bump(version, root = ".") {
  if (!SEMVER.test(version)) throw new Error(`not a semver version: ${version}`);
  for (const m of MANIFESTS) {
    const f = path.join(root, m.file);
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    m.pick(j).version = version;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  }
  return version;
}

// Throws unless every manifest agrees and the tag equals that version.
export function checkTag(tag, root = ".") {
  const vs = readVersions(root);
  const want = vs[0].version;
  const odd = vs.filter((v) => v.version !== want);
  if (odd.length) throw new Error("manifests disagree: " + vs.map((v) => `${v.file}=${v.version}`).join(", "));
  if (tag.replace(/^v/, "") !== want) throw new Error(`tag ${tag} != plugin.json version ${want}`);
  return want;
}

export function changelogHas(version, root = ".") {
  const t = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  return new RegExp(`^## ${version.replace(/\./g, "\\.")}( |$)`, "m").test(t) || /^## Unreleased/m.test(t);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === "bump") console.log("bumped six manifests to " + bump(arg));
    else if (cmd === "check-tag") console.log("tag ok: " + checkTag(arg));
    else if (cmd === "check-changed") {
      // arg = last tag, process.argv[4] = base ref (default origin/main). A PR that touches enforcer/ either
      // bumps the version (and the changelog covers it) or adds one fragment under changes/ — one small file per
      // PR so parallel PRs never conflict on CHANGELOG.md; the release node folds the fragments into the heading.
      const cur = readVersions()[0].version;
      const base = process.argv[4] || "origin/main";
      if (cur !== arg.replace(/^v/, "")) {
        if (!changelogHas(cur)) throw new Error(`CHANGELOG.md has no "## ${cur}" or "## Unreleased" entry`);
        console.log(`version ${cur} differs from ${arg} and CHANGELOG.md covers it`);
      } else {
        const added = execSync(`git diff --name-only --diff-filter=A ${base}...HEAD -- changes/`, { encoding: "utf8" }).split("\n").filter((f) => /^changes\/[^/]+\.md$/.test(f));
        if (!added.length) throw new Error(`enforcer/ changed at version ${cur} (last tag ${arg}) with no changes/<slug>.md fragment; add one line under changes/ (or run npm run bump <version> for a release)`);
        console.log(`version unchanged; fragment(s) added: ${added.join(", ")}`);
      }
    } else throw new Error("usage: release.mjs bump <v> | check-tag <tag> | check-changed <last-tag>");
  } catch (e) { console.error("FAIL " + e.message); process.exit(1); }
}
