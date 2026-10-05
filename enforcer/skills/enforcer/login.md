# login

Sign this machine in to Enforcer, once, for the Enforcer MCP server and every Instruxi plugin.

Arguments: `[<WORKSPACE-CODE>] [--for work|plan|admin] [--scope "<scopes>"] | api-key <key> | scopes | status | logout`

Tools used: Bash(node:*)
Sign in to Enforcer and print the result verbatim. With no argument this opens a browser sign-in and waits for it to finish. With a workspace code (e.g. `ACME-1234-ABCD`, or `ENFORCER_TENANT_CODE` in settings) the sign-in page skips asking for it. `--for work` (default; the work loop's 7 scopes), `--for plan` (work plus graph/template/epoch writes) or `--for admin` (every scope offered) pick a preset; the default is the last preset used.  `--scope "enforcer:read policy:self"` asks for only those (each must be offered, or it refuses before opening the browser), and `scopes` lists what is offered.

Run `node bin/login.mjs <arguments>` from the plugin root and print the output verbatim.
