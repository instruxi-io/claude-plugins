// Every state file this plugin writes carries `schema_version`. A reader older than the file refuses it
// with a clear message instead of misreading (or overwriting) newer state.
export const SCHEMA_VERSION = 1;

export class SchemaError extends Error {
  constructor(what, found) {
    super(`${what} was written by a newer enforcer (schema_version ${found}, this plugin reads up to ${SCHEMA_VERSION}); update the plugin instead of downgrading`);
    this.name = 'SchemaError';
    this.found = found;
  }
}

/** Throw SchemaError when `doc` is newer than this reader understands. Files with no schema_version are version 0. */
export function assertSchema(doc, what = 'this state file') {
  const v = Number(doc?.schema_version ?? 0);
  if (Number.isFinite(v) && v > SCHEMA_VERSION) throw new SchemaError(what, v);
  return doc;
}

/** The document with the current schema_version first. */
export const stamp = (doc) => { const { schema_version: _old, ...rest } = doc || {}; return { schema_version: SCHEMA_VERSION, ...rest }; };
