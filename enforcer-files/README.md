# enforcer-files plugin for Claude Code

Files in your Enforcer workspace, from Claude Code.

- **Find, inspect, share** through the `enforcer` MCP server's `files_*`
  operations (via `enforcer_api_search` / `_read` / `_write`). The `files` skill
  tells Claude how.
- **Move the bytes** with two commands. The file goes between this machine and
  storage directly, never through the model or the MCP server:
  - `/enforcer-files:upload <path> [--name <file_name>] [--dir <directory>] [--overwrite]`
  - `/enforcer-files:download <file_id|object_key> [--out <path>]`

The tenant's storage provider decides the flow: S3 uploads go straight to
storage through a short-lived presigned URL and are then recorded; GCS and
Storj uploads pass through enforcer-files as multipart.

## Install

```sh
claude plugin marketplace add instruxi-io/claude-plugins
claude plugin install enforcer@instruxi          # the MCP server and the sign-in
claude plugin install enforcer-files@instruxi
```

Sign in once with `/enforcer:login`. That sign-in carries `files-files.write`
(list, read, upload, move, copy) and `files-sharing.write` (share with groups).
Trash, delete and Storj access grants (`.destructive`) are not granted to a
sign-in; buckets, connections and the OCR queue are admin-only.

CI and containers: set a scoped `ENFORCER_API_KEY` instead of signing in.

## Test

```sh
cd enforcer-files && npm test     # both provider flows against a local stub
```
