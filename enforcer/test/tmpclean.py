"""Import first: private tempdir for this process, removed at exit."""
import atexit, os, shutil, tempfile
_d = tempfile.mkdtemp(prefix="enf-test-")
os.environ["TMPDIR"] = _d
tempfile.tempdir = _d
atexit.register(shutil.rmtree, _d, True)
# Isolation: never the developer's HOME, sign-in or harness environment.
import re as _re
os.makedirs(os.path.join(_d, "home"), exist_ok=True)
os.environ["HOME"] = os.path.join(_d, "home")
for _k in list(os.environ):
    if _re.match(r"^(ENFORCER_|JEV_HOOKS_|GRAPH_|CLAUDE_PLUGIN_|TYPESAFE_)", _k):
        del os.environ[_k]
