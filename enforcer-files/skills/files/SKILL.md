---
name: files
description: Work with files in the user's Enforcer workspace — find, inspect, share with a group, upload and download. Use when the user mentions files, documents, uploads, attachments or storage in Enforcer, or asks to put a local file into their workspace or get one out of it.
---

# Enforcer files

Files live in the workspace's storage provider (S3, GCS or Storj; the tenant
chooses). One grant means the same on every provider.

## Finding and inspecting: the MCP server

Use the `enforcer` MCP server's catalog. Search, then read or write:

- `enforcer_api_search` with `tag: "files-files"` (files) or `"files-sharing"` (groups)
- `enforcer_api_read` for lists, metadata, presigned download URLs
- `enforcer_api_write` for move, copy, and sharing (the user confirms each write)

Ask `files_getActiveStorageProvider` first when it matters: the provider decides
which `files_*` operation applies (`files_listS3Files` vs `files_listGcsFiles`).

## Moving bytes: the commands, never the tools

A tool call cannot carry a file, and a file's contents should not pass through
the model. Use:

- `/enforcer-files:upload <path> [--dir <directory>] [--overwrite]`
- `/enforcer-files:download <file_id|object_key> [--out <path>]`

They pick the provider's flow themselves (presigned URL for S3, multipart for
GCS and Storj) and use the `/enforcer:login` sign-in.

## What a sign-in may do

Scopes are `enforcer:files-<tag>.<effect>`. A browser sign-in carries
`files-files.write` (list, read, upload, move, copy) and `files-sharing.write`
(share and unshare with groups). It does NOT carry `.destructive`: trash,
delete and Storj access grants stay with a person, in the app. Buckets,
connections and the OCR queue (`files-storage`, `files-ocr`) are admin-only.

A refusal with `insufficient_scope` means the credential is narrower than the
call. Say which scope the message names; do not retry it.
