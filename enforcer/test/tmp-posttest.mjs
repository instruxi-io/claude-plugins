// npm itself drops node-compile-cache into TMPDIR; remove it so a test run leaves TMPDIR as it found it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
try { fs.rmSync(path.join(os.tmpdir(), 'node-compile-cache'), { recursive: true, force: true }); } catch {}
