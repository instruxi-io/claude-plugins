# On PYTHONPATH of a child: resolving api.instruxi.dev is recorded and refused.
import os, socket
_real = socket.getaddrinfo
def _guard(host, *a, **k):
    if str(host).endswith("instruxi.dev"):
        open(os.environ["NOPROD_LOG"], "a").write("dns %s\n" % host)
        raise OSError("production is off limits in this test")
    return _real(host, *a, **k)
socket.getaddrinfo = _guard
