import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redact } from '../../src/graph/redact.mjs';
import { clipOutput } from '../../src/graph/clip.mjs';

const LIB = fileURLToPath(new URL('../../lib/graph/lib.py', import.meta.url));
const py = (code, input) => execFileSync('python3', ['-I', '-c', code, LIB], { input, encoding: 'utf8' });

const check = (text, secret, kind) => {
  const [out, n] = redact(text);
  assert.ok(!out.includes(secret), `${kind}: secret leaked`);
  assert.ok(out.includes(`[redacted:${kind}]`));
  assert.ok(n >= 1);
};

test('redact: every pattern class', () => {
  check("curl -H 'Authorization: Bearer abcdef123456SECRET'", 'abcdef123456SECRET', 'bearer');
  check('Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA', 'basic');
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM';
  check('token ' + jwt, jwt, 'jwt');
  assert.equal(redact('PATH=/bin\nFOO_TOKEN=abc\nHOME=/h')[0], 'PATH=/bin\nFOO_TOKEN=[redacted:env]\nHOME=/h');
  check('DB_PASSWORD="hunter two"', 'hunter', 'env');
  check('x\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\ndef\n-----END RSA PRIVATE KEY-----\ny', 'MIIEabc', 'pem');
  check('id AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE', 'aws');
  for (const t of ['ghp_' + 'a'.repeat(36), 'gho_' + 'b'.repeat(36), 'github_pat_' + 'c'.repeat(30)]) check('t=' + t, t, 'github');
  check('xoxb-123456789012-abcdefghij', 'abcdefghij', 'slack');
  check("curl -H 'X-API-Key: s3cr3tvalue' http://x", 's3cr3tvalue', 'apikey');
  assert.deepEqual(redact('ls -la\nok'), ['ls -la\nok', 0]);
});

const CORPUS = [
  'Authorization: Bearer abcdef123456SECRET', 'bearer   tok_1234567890', 'Bearer short',
  'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'basic abcdefgh',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM', 'jwt eyJabcde.fghijk.',
  'FOO_TOKEN=abc', 'API_KEY = "two words"', "SECRET='single quoted'", 'DB_PASSWORD=hunter2 other=1', 'FOO_TOKEN=[redacted:env]',
  'MY_KEYBOARD=qwerty', 'key=lower',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\nunterminated\nbody',
  'AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE and AKIAshort',
  'ghp_' + 'a'.repeat(36), 'github_pat_' + 'c'.repeat(30), 'ghs_tooshort',
  'xoxb-123456789012-abcdefghij', 'xoxp-1-2',
  "curl -H 'X-API-Key: s3cr3tvalue' http://x", 'x-api-key:   abc', 'X-API-Key:',
  'ls -la\nok', 'plain text with no secrets at all',
  'a Bearer abcdefgh1 and AKIAIOSFODNN7EXAMPLE and FOO_SECRET=zz',
  'multi\nline\nTOKEN=a\nPASSWORD="b c"\nend',
  'url https://x.test/?token=abcdef&key=123', 'KEY=', 'export GITHUB_TOKEN=ghp_' + 'z'.repeat(30),
  'tab\tSECRET=\tvalue', 'unicode café TOKEN=ü', 'Bearer ' + 'A'.repeat(200),
  'eyJ' + 'a'.repeat(10) + '.' + 'b'.repeat(10) + '.' + 'c'.repeat(10),
  'BASIC dXNlcjpwYXNz', 'xoxa-aaaaaaaaaa-bbbbbbbbbb', 'gho_' + 'q'.repeat(25) + ' trailing',
];

test('redaction corpus identical in Python and Node', () => {
  assert.equal(CORPUS.length, 40);
  const code = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location("graph_lib",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps([list(m.redact(t)) for t in json.load(sys.stdin)]))`;
  const want = JSON.parse(py(code, JSON.stringify(CORPUS)));
  const got = CORPUS.map((t) => redact(t));
  for (let i = 0; i < CORPUS.length; i++) assert.deepEqual(got[i], want[i], `corpus[${i}] ${JSON.stringify(CORPUS[i])}`);
});

test('clip keeps head and tail, same as python', () => {
  const s = 'H'.repeat(3000) + 'M'.repeat(3000) + 'verdict: ok';
  const out = clipOutput(s);
  assert.equal(out.length, 4000);
  assert.ok(out.endsWith('verdict: ok'));
  assert.equal(clipOutput('short'), 'short');
  const code = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location("graph_lib",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.clip_output(json.load(sys.stdin))))`;
  assert.equal(JSON.parse(py(code, JSON.stringify(s))), out);
});
