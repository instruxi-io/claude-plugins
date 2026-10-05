"""Version drift report for SessionStart: one line per mismatch, nothing when aligned.

  * every installed copy of an Instruxi plugin (each scope is its own entry in
    installed_plugins.json) older than the marketplace manifest's version;
  * tools the MCP server serves (GET /api/v1/mcp/health) that this plugin does
    not know (hooks/known_tools.json, vendored from the server's manifest);
  * the workspace the stored credential is bound to (from the JWT claims, no call).

One GET at most, short timeout, never raises."""
import base64, json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "hooks", "claude"))
from claude_paths import MANIFEST_DIR

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BASE = "https://api.instruxi.dev"


def vtuple(v):
    out = []
    for part in str(v or "").split("-")[0].split("."):
        try:
            out.append(int(part))
        except ValueError:
            return None
    return tuple(out) if out else None


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def stale_installs(installed, catalog_versions, mkt):
    """installed: installed_plugins.json 'plugins'; catalog_versions: {name: version}."""
    out = []
    for name, avail in sorted(catalog_versions.items()):
        pid = f"{name}@{mkt}"
        av = vtuple(avail)
        for i in installed.get(pid) or []:
            if not isinstance(i, dict):
                continue
            hv = vtuple(i.get("version"))
            if hv and av and hv < av:
                out.append(f"{name} {i.get('version')} installed ({i.get('scope') or 'unknown scope'}) — "
                           f"{avail} available: claude plugin update {pid}")
    return out


def tool_names(health):
    d = health.get("data") if isinstance(health.get("data"), dict) else health
    tools = d.get("tools") or []
    return {(t.get("name") if isinstance(t, dict) else t) for t in tools if t}, d.get("version")


def unknown_tools(health, known, plugin_version):
    names, ver = tool_names(health)
    extra = sorted(n for n in names if isinstance(n, str) and n not in known)
    if not extra:
        return []
    fams = {}
    for n in extra:
        fams.setdefault(n.split("_")[0] if "_" in n else n, []).append(n)
    shown = ", ".join(f"{f}_*" if len(v) > 1 or v[0] != f else f for f, v in sorted(fams.items()))
    return [f"MCP {ver or '?'} serves tools this plugin ({plugin_version}) does not know: {shown}"]


def jwt_claims(tok):
    try:
        p = str(tok).split(".")[1]
        return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
    except Exception:
        return {}


def workspace_line(doc):
    o = ((doc or {}).get("enforcer") or {}).get("oauth") or {}
    if not o.get("access_token"):
        return None
    c = jwt_claims(o["access_token"])
    name = c.get("tenant") or c.get("tenant_name") or c.get("tenant_code")
    tid = c.get("tenant_id")
    if not (name or tid):
        return None
    return f"enforcer workspace: {name or tid}" + (f" ({tid})" if name and tid else "") + (f" · role {c['role']}" if c.get("role") else "")


def fetch_health(base, auth=None, timeout=1.5):
    import urllib.request
    h = {"User-Agent": "enforcer-graph-plugin-versioncheck", **(auth or {})}
    try:
        with urllib.request.urlopen(urllib.request.Request(f"{base.rstrip('/')}/api/v1/mcp/health", headers=h), timeout=timeout) as r:
            d = json.loads(r.read() or b"null")
            return d if isinstance(d, dict) else None
    except Exception:
        return None


def report(cfgdir, mkt, plugin_version, doc, base, auth, health=None):
    """The lines to print. `health` injected by tests; fetched otherwise."""
    lines = []
    installed = ((load(os.path.join(cfgdir, "plugins", "installed_plugins.json")) or {}).get("plugins")) or {}
    loc = (((load(os.path.join(cfgdir, "plugins", "known_marketplaces.json")) or {}).get(mkt)) or {}).get("installLocation")
    catalog = load(os.path.join(loc, MANIFEST_DIR, "marketplace.json")) if loc else None
    versions = {}
    for e in (catalog or {}).get("plugins") or []:
        if isinstance(e.get("source"), str):
            v = (load(os.path.join(loc, e["source"], MANIFEST_DIR, "plugin.json")) or {}).get("version")
            if v:
                versions[e["name"]] = v
    lines += stale_installs(installed, versions, mkt)
    if health is None:
        health = fetch_health(base, auth)
    known = load(os.path.join(HERE, "known_tools.json")) or []
    if health and known:
        lines += unknown_tools(health, set(known), plugin_version)
    return lines
