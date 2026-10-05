"""Import first: private tempdir for this process, removed at exit."""
import atexit, os, shutil, tempfile
_d = tempfile.mkdtemp(prefix="enf-test-")
os.environ["TMPDIR"] = _d
tempfile.tempdir = _d
atexit.register(shutil.rmtree, _d, True)
