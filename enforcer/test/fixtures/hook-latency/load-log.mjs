// Preload for test/hook-latency.test.mjs: logs every file module the process loads, one
// `LOADED <file url>` line on stderr each, so the test can say which modules an event pulled in.
import { register } from 'node:module';

const hooks = `export async function load(url, context, next) {
  if (url.startsWith('file:')) process.stderr.write('LOADED ' + url + '\\n');
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
