// The one credentials module lives in enforcer/src/credentials.mjs. The governor
// re-exports it so both read and write the same ~/.enforcer/credentials.json
// with the same code. Do not fork it here.
export * from '../../../src/credentials.mjs';
