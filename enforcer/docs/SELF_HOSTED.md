# Running against a self-hosted Enforcer

1. Point everything at your server, in your shell profile:

   ```sh
   export ENFORCER_BASE_URL=https://enforcer.example.com
   ```

   `login`, `doctor`, the hooks, the governor and the dispatcher all read it; it beats whatever a previous sign-in saved. The graph API becomes `$ENFORCER_BASE_URL/api/v1/graph`; set `GRAPH_BASE_URL` only if yours differs.

2. Sign in: `/enforcer:login` (or `enforcer login`). The sign-in saves the base URL, so later shells without the variable still reach your server. `--base-url https://other.example` overrides both for one run.

3. Point the MCP server at it. The plugin's `.mcp.json` names production, so register your own server entry for your user:

   ```sh
   claude mcp add --transport http enforcer "$ENFORCER_BASE_URL/mcp"
   ```

   The auth helper (`bin/enforcer-headers.mjs`) reads the same credentials file, so the token follows.

4. Check: `enforcer doctor` prints `<your base>/mcp answered HTTP ...` and `ok  environment variables valid`. `enforcer login status` prints `Signed in to <your base>`.

5. Dispatch: `enforcer dispatch <graph>` uses the derived graph URL.

`test/config.test.mjs` proves this: with `ENFORCER_BASE_URL` set to a stub, login status, doctor, a hook heartbeat and a dispatcher dry-run all reach the stub and none resolves `api.instruxi.dev`.
