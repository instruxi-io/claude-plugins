// Detached entry for the heartbeat ticker (spawned by ticker.mjs startTicker).
import { tickLoop } from './ticker.mjs';
let inp = {};
try { inp = JSON.parse(process.env.ENFORCER_TICKER_INPUT || '{}'); } catch {}
delete process.env.ENFORCER_TICKER_INPUT;
tickLoop(inp).then(() => process.exit(0), () => process.exit(1));
