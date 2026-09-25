"""Shared by every hook. Config, HTTP to the graph API, the open-run file.

Every hook FAILS OPEN: no config, no credential, API down, malformed stdin -> exit 0,
no output. A coordination service must never be the reason a session stalls.
Nothing here calls Jev or any model; hooks are plain HTTP to enforcer-graph.
"""
import hashlib
import json, os, re, sys

HTTP_TIMEOUT = float(os.environ.get("GRAPH_HOOK_TIMEOUT", "1.5"))

# Every request names itself. api.instruxi.dev sits behind Cloudflare, which
# answers urllib's default "Python-urllib/3.x" with 403 "error code: 1010"
# (a banned client signature) before the request reaches the API. Because every
# hook fails open, that looked exactly like "no graph configured": verified
# 2026-09-23, the same call was 403 with the default agent and 200 with this one.
USER_AGENT = "enforcer-graph-plugin/0.7.0"


def read_stdin():
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}


def find_config(start):
    """Walk up from `start` for .claude/graph.json. Env overrides win field by field."""
    cfg = {}
    d = os.path.abspath(start or os.getcwd())
    while True:
        p = os.path.join(d, ".claude", "graph.json")
        if os.path.exists(p):
            try:
                cfg = json.load(open(p))
            except Exception:
                cfg = {}
            break
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    if os.environ.get("GRAPH_ID"):
        cfg["graph_id"] = os.environ["GRAPH_ID"]
    if os.environ.get("GRAPH_BASE_URL"):
        cfg["base_url"] = os.environ["GRAPH_BASE_URL"]
    key_env = cfg.get("api_key_env") or "GRAPH_API_KEY"
    cfg["api_key"] = os.environ.get(key_env) or os.environ.get("GRAPH_API_KEY") or ""
    creds = None if cfg["api_key"] else read_credentials()
    if not cfg.get("base_url") and creds:
        cfg["base_url"] = creds.get("enforcer", {}).get("base_url") or ""
    cfg["base_url"] = (cfg.get("base_url") or "").rstrip("/")
    if not cfg.get("graph_id") or not cfg["base_url"]:
        return None
    if not cfg["api_key"] and not _has_credential(creds):
        return None
    return cfg


# --- The Enforcer sign-in -------------------------------------------------
#
# Without GRAPH_API_KEY the hooks use the credential the `enforcer` plugin and
# enforcer-governor share: ~/.enforcer/credentials.json, written by
# /enforcer:login. That is what lets a harness run on one OAuth sign-in with no
# key anywhere. The file format is owned by those plugins (src/credentials.mjs);
# this reads it and, when refreshing, writes it back in the same shape.
#
# The environment still wins, so CI and containers can inject a key without a
# home directory.

REFRESH_SKEW_S = 60


def _enforcer_home():
    return os.environ.get("ENFORCER_HOME") or os.path.join(os.path.expanduser("~"), ".enforcer")


def _credentials_file():
    return os.path.join(_enforcer_home(), "credentials.json")


def read_credentials():
    """The shared credential document, or None. The governor's pre-shared-file
    location is still read, as the other plugins do."""
    legacy = os.path.join(os.environ.get("GOVERNOR_HOME") or os.path.expanduser("~/.enforcer-governor"), "credentials.json")
    for f in (_credentials_file(), legacy):
        try:
            doc = json.load(open(f))
            if isinstance(doc, dict) and isinstance(doc.get("enforcer"), dict):
                return doc
        except Exception:
            continue
    return None


def _has_credential(doc):
    e = (doc or {}).get("enforcer") or {}
    return bool(os.environ.get("ENFORCER_API_KEY") or e.get("api_key") or (e.get("oauth") or {}).get("access_token"))


def _expires_in(o):
    """Seconds until the access token expires; a large number when unknown."""
    import datetime
    try:
        at = datetime.datetime.fromisoformat(str(o["expires_at"]).replace("Z", "+00:00"))
        return (at - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
    except Exception:
        return 1e9


def _save_credentials(doc):
    """Atomic and 0600, like the Node writer: a hook and the MCP helper read
    this file concurrently, so neither may ever see half of it."""
    d = _enforcer_home()
    os.makedirs(d, mode=0o700, exist_ok=True)
    tmp = os.path.join(d, ".credentials.%d.tmp" % os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, _credentials_file())


def _refresh(doc):
    """Redeem the refresh token and write the rotated pair back. Returns the new
    access token, or None (signed out) on any failure.

    Refresh tokens are single-use and rotate, and several hooks can fire at
    once, so the exchange runs under a lock and re-reads the file first: if
    another process already refreshed, its token is used instead of spending a
    refresh token that has just been superseded."""
    import fcntl, urllib.parse, urllib.request
    os.makedirs(_enforcer_home(), mode=0o700, exist_ok=True)
    with open(os.path.join(_enforcer_home(), ".refresh.lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        doc = read_credentials() or doc
        o = doc["enforcer"].get("oauth") or {}
        if o.get("access_token") and _expires_in(o) > REFRESH_SKEW_S:
            return o["access_token"]
        if not (o.get("refresh_token") and o.get("token_endpoint") and o.get("client_id")):
            return None
        body = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": o["refresh_token"],
                                       "client_id": o["client_id"]}).encode()
        req = urllib.request.Request(o["token_endpoint"], data=body, method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=max(HTTP_TIMEOUT, 3.0)) as r:
                t = json.loads(r.read() or b"{}")
        except Exception:
            return None
        if not t.get("access_token"):
            return None
        import datetime
        ttl = int(t.get("expires_in") or 900)
        o = dict(o, access_token=t["access_token"], refresh_token=t.get("refresh_token") or o["refresh_token"],
                 expires_at=(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=ttl))
                 .strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                 scope=t.get("scope") or o.get("scope"))
        doc["enforcer"]["oauth"] = o
        try:
            _save_credentials(doc)
        except Exception:
            pass  # the token still works for this call; the next hook refreshes again
        return o["access_token"]


def auth_headers(cfg):
    """The headers that authenticate a call, or {} when there is nothing to send.
    A key (GRAPH_API_KEY, then ENFORCER_API_KEY, then a saved key) wins over an
    OAuth sign-in, as in the other Enforcer plugins."""
    if cfg.get("api_key"):
        return {"X-API-Key": cfg["api_key"]}
    if os.environ.get("ENFORCER_API_KEY"):
        return {"X-API-Key": os.environ["ENFORCER_API_KEY"]}
    doc = read_credentials()
    e = (doc or {}).get("enforcer") or {}
    if e.get("api_key"):
        return {"X-API-Key": e["api_key"]}
    o = e.get("oauth") or {}
    if not o.get("access_token"):
        return {}
    tok = o["access_token"] if _expires_in(o) > REFRESH_SKEW_S else _refresh(doc)
    return {"Authorization": "Bearer " + tok} if tok else {}


# The graph's tools reach Claude Code under whichever MCP server carries them:
# the `enforcer` plugin's (mcp__plugin_enforcer_enforcer__), one added by hand
# as `enforcer`, or the older key-based `enforcer-graph` entry. hooks.json
# matches the same three.
GRAPH_TOOL_PREFIXES = ("mcp__plugin_enforcer_enforcer__graph_", "mcp__enforcer__graph_", "mcp__enforcer-graph__graph_")


def is_graph_tool(name):
    return (name or "").startswith(GRAPH_TOOL_PREFIXES)


def http(cfg, method, path, body=None):
    """Returns the parsed JSON body or None. Never raises."""
    import urllib.request  # deferred: the capture hook runs on every tool call and never does HTTP
    url = f"{cfg['base_url']}/api/v1/graph{path}"
    data = json.dumps(body).encode() if body is not None else None
    auth = auth_headers(cfg)
    if not auth:
        return None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={**auth, "Content-Type": "application/json", "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            out = json.loads(r.read() or b"null")
            return out if isinstance(out, dict) and out.get("success", True) else None
    except Exception:  # 4xx/5xx, timeouts, DNS, bad JSON: a hook has no use for the error body
        return None


def data_dir():
    d = os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.expanduser("~/.claude/enforcer-graph")
    d = os.path.join(d, "runs")
    os.makedirs(d, exist_ok=True)
    return d


def actor_key(inp):
    """The identity a run and its captured evidence belong to. NOT the session.

    Hooks fire in the PARENT session's context for a SUBAGENT's tool calls, so
    keying by session_id alone merges every agent in one session into one run
    file and one evidence file. Measured on 2026-09-20 with two agents claiming
    in parallel: the later claim OVERWROTE the earlier in the run file; one
    evidence file collected both agents' tool results; the first report attached
    20 items of which 9 came from the OTHER agent's worktree; and clearing on
    that report deleted the shared state, after which the second agent captured
    nothing and its report came back `unsupported`, reason `no_evidence`, for
    work that was in fact done and tested.

    `agent_id` is the documented field for exactly this: Claude Code delivers
    it, with `agent_type`, ONLY when the hook fires inside a subagent. So its
    presence separates subagents from each other, and its ABSENCE identifies the
    parent — which is why the parent still keys by session_id and every
    single-agent session behaves precisely as it did before.

    Hashed with its field name because these become filenames and an agent id is
    opaque.
    """
    inp = inp or {}
    aid = inp.get("agent_id")
    if aid:
        return hashlib.sha256(("agent_id:%s" % aid).encode()).hexdigest()[:32]
    return inp.get("session_id") or "unknown"


def run_path(session_id):
    return os.path.join(data_dir(), f"{session_id or 'unknown'}.json")


def load_run(session_id):
    try:
        return json.load(open(run_path(session_id)))
    except Exception:
        return None


def save_run(session_id, run):
    with open(run_path(session_id), "w") as f:
        json.dump(run, f)


def clear_run(session_id):
    for suffix in (".json", ".count"):
        try:
            os.remove(os.path.join(data_dir(), f"{session_id or 'unknown'}{suffix}"))
        except Exception:
            pass
    clear_evidence(session_id)


# --- captured evidence -------------------------------------------------------
# Records the agent did not write: one JSON object per line, appended by
# capture_evidence.py as the tool results come back, read once by
# attach_evidence.py when graph_report is about to run. Each line is already in
# the shape the server accepts, so nothing has to be rewritten at report time.

EVIDENCE_CAP = 20          # the server accepts at most this many items
OUTPUT_CLIP = 4000         # per command record, stdout+stderr together
EXCERPT_CLIP = 600         # per file record


def clip_output(s, n=OUTPUT_CLIP, head_share=0.3):
    """Clip command output to n characters keeping BOTH ends.

    A test runner, a build and a linter all print their verdict LAST: `ok`,
    `FAIL`, `Tests 2879 passed`, `exit status 1`. Keeping only the first n
    characters - what this did until 2026-09-24 - handed the judge the start of
    a long log and never the line saying whether it passed. The head is kept
    too, because a compile error or a panic surfaces there. The marker says how
    much went missing, so the judge knows the middle exists.
    """
    if len(s) <= n:
        return s
    head = int(n * head_share)
    marker = ""
    for _ in range(3):  # the count's own digits change the marker's length
        tail = n - head - len(marker)
        marker = f"\n...[{len(s) - head - tail} characters elided]...\n"
    tail = n - head - len(marker)
    if tail <= 0:
        return s[:n]
    return s[:head] + marker + s[-tail:]


# --- full outputs in enforcer-files ---------------------------------------
#
# The clip above keeps the verdict line and loses the middle, and the person
# reading a rejected verdict sometimes needs the middle. The hook has the bytes
# and the USER's credential at report time; the graph server has neither and
# must never become a file store. So a command output longer than the clip is
# uploaded to the user's own enforcer-files storage, under the user's own
# credential, and the evidence item carries its id (`file`) and size
# (`file_bytes`). The server judges the clip exactly as before and tells the
# judge the whole is stored; it never downloads it.
#
# Configured by `files_base_url` in .claude/graph.json (or GRAPH_FILES_BASE_URL),
# the enforcer-files base INCLUDING its /api/v1/files prefix. Unset disables
# uploads: no network call at all. Everything here FAILS OPEN — an upload that
# fails leaves the item exactly as it was (clipped, no file) and the report goes.

RAW_KEEP = 5 * 1024 * 1024   # the most of one output kept in the capture file
UPLOAD_BUDGET_S = 10.0       # every upload of one report together, not each
_provider_cache = {}         # base url -> provider, read once per process


def files_base_url(cfg):
    base = os.environ.get("GRAPH_FILES_BASE_URL") or (cfg or {}).get("files_base_url") or ""
    return str(base).strip().rstrip("/")


def _files_request(url, auth, timeout, data=None, content_type=None):
    import urllib.request
    headers = {**auth, "User-Agent": USER_AGENT, "Accept": "application/json"}
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET", headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def _files_provider(base, auth, timeout):
    """GET /storage/provider: which backend serves THIS user's tenant. Read,
    never assumed (enforcer-graph GRAPH.md §6): the upload path is
    /storage/file/{provider}/upload and a tenant on storj or gcs 404s on a
    hardcoded /s3/. A failed read is not cached, so the next report retries."""
    if base in _provider_cache:
        return _provider_cache[base]
    d = _files_request(base + "/storage/provider", auth, timeout)
    prov = d.get("provider") if isinstance(d, dict) and d.get("configured") else None
    if not isinstance(prov, str) or not re.fullmatch(r"[a-z0-9_-]{1,32}", prov):
        return None
    _provider_cache[base] = prov
    return prov


UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def upload_full_output(text, cfg, timeout=UPLOAD_BUDGET_S):
    """Store `text` in the user's enforcer-files and return its file_id, or
    None. Multipart POST to /storage/file/{provider}/upload — the proxy flow
    every provider serves, as enforcer-graph's exports use it. Never raises."""
    try:
        base = files_base_url(cfg)
        if not base or timeout <= 0:
            return None
        auth = auth_headers(cfg)
        if not auth:
            return None
        prov = _files_provider(base, auth, timeout)
        if not prov:
            return None
        body = text.encode("utf-8", "replace")
        # A name of its own per upload: enforcer-files answers a same-path
        # upload 409 unless told to overwrite, and a log must never replace one.
        import datetime, uuid
        name = "graph-evidence/%s-%s.log" % (
            datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"), uuid.uuid4().hex[:12])
        b = ("enforcer-graph-" + uuid.uuid4().hex).encode()
        payload = b"".join([
            b"--", b, b"\r\n",
            b'Content-Disposition: form-data; name="file"; filename="', name.split("/")[-1].encode(), b'"\r\n',
            b"Content-Type: text/plain; charset=utf-8\r\n\r\n", body, b"\r\n",
            b"--", b, b"\r\n",
            b'Content-Disposition: form-data; name="file_name"\r\n\r\n', name.encode(), b"\r\n",
            b"--", b, b"--\r\n",
        ])
        d = _files_request("%s/storage/file/%s/upload" % (base, prov), auth, timeout,
                           data=payload, content_type="multipart/form-data; boundary=" + b.decode())
        fid = ((d or {}).get("data") or {}).get("file_id") if isinstance(d, dict) else None
        if isinstance(fid, str) and UUID_RE.fullmatch(fid.strip()):
            return fid.strip().lower()
    except Exception:
        pass
    return None


def attach_files(items, cfg):
    """For every item that carries its `raw` output (captured only when the
    output exceeded the clip), upload it and set `file` / `file_bytes`. `raw`
    is ALWAYS removed: it never reaches the report. Bounded by UPLOAD_BUDGET_S
    across every item; one that does not fit is left as it is today."""
    import time
    deadline = time.monotonic() + UPLOAD_BUDGET_S
    enabled = bool(files_base_url(cfg)) and cfg is not None
    for it in items:
        if not isinstance(it, dict) or "raw" not in it:
            continue
        raw = it.pop("raw")
        if not enabled or not isinstance(raw, str) or len(raw) <= OUTPUT_CLIP:
            continue
        fid = upload_full_output(raw, cfg, timeout=deadline - time.monotonic())
        if fid:
            it["file"] = fid
            it["file_bytes"] = len(raw.encode("utf-8", "replace"))
    return items


def evidence_dir():
    d = os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.expanduser("~/.claude/enforcer-graph")
    d = os.path.join(d, "evidence")
    os.makedirs(d, exist_ok=True)
    return d


def evidence_path(session_id):
    return os.path.join(evidence_dir(), f"{session_id or 'unknown'}.jsonl")


def append_evidence(session_id, record):
    """Never raises. A capture that cannot be written is a capture that did not
    happen; it must not cost the session a tool call."""
    try:
        with open(evidence_path(session_id), "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass


def load_evidence(session_id):
    out = []
    try:
        with open(evidence_path(session_id)) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except Exception:
                    continue          # a truncated line loses one record, not the file
                if isinstance(rec, dict) and rec.get("kind"):
                    out.append(rec)
    except Exception:
        pass
    return out


def clear_evidence(session_id):
    try:
        os.remove(evidence_path(session_id))
    except Exception:
        pass


def select_evidence(records, cap=EVIDENCE_CAP):
    """Cap the capture at what the server accepts, keeping what a judge needs.

    Priority when there are more than `cap`: failing commands, then the most
    recent commands, then file changes. Failing commands are emitted FIRST -
    a report whose evidence opens with the command that did not pass cannot be
    read as a clean run.
    """
    if len(records) <= cap:
        failed = [r for r in records if r.get("kind") == "command" and r.get("exit") not in (0, None)]
        rest = [r for r in records if r not in failed] if failed else records
        return failed + rest if failed else list(records)

    idx = list(enumerate(records))
    failed = [(i, r) for i, r in idx if r.get("kind") == "command" and r.get("exit") not in (0, None)]
    other_cmd = [(i, r) for i, r in idx if r.get("kind") == "command" and (i, r) not in failed]
    files = [(i, r) for i, r in idx if r.get("kind") != "command"]

    keep = failed[-cap:]                                   # every failure that fits, oldest of them first
    room = cap - len(keep)
    tail = (other_cmd[-room:] if room > 0 else [])         # then the most recent commands
    room = cap - len(keep) - len(tail)
    tail += (files[-room:] if room > 0 else [])            # then the most recent file changes
    tail.sort(key=lambda t: t[0])
    return [r for _, r in keep] + [r for _, r in tail]


def tool_payload(tool_response):
    """An MCP tool's result reaches a hook as a string, a list of content blocks,
    or an object with `content`. The workflow tools put one JSON document in the
    first text block. Return it parsed, or {}."""
    r = tool_response
    if isinstance(r, dict) and "content" in r and not r.get("state"):
        r = r["content"]
    if isinstance(r, list):
        texts = [b.get("text") for b in r if isinstance(b, dict) and b.get("type") == "text"]
        r = "\n".join(t for t in texts if t)
    if isinstance(r, str):
        s = r.strip()
        try:
            return json.loads(s)
        except Exception:
            a, b = s.find("{"), s.rfind("}")
            if a >= 0 and b > a:
                try:
                    return json.loads(s[a:b + 1])
                except Exception:
                    return {}
            return {}
    return r if isinstance(r, dict) else {}


def last_assistant_text(transcript_path, limit=1500):
    last = ""
    try:
        with open(transcript_path) as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if rec.get("type") != "assistant":
                    continue
                c = (rec.get("message") or {}).get("content")
                if isinstance(c, list):
                    for b in c:
                        if isinstance(b, dict) and b.get("type") == "text" and b.get("text", "").strip():
                            last = b["text"].strip()
    except Exception:
        pass
    return last[:limit]
