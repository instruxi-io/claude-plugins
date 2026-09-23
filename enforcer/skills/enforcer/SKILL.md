---
name: enforcer
description: How Enforcer is organised — tenants, accounts, roles, scopes — and how to look up anything else from the live API instead of from memory. Use when the user mentions Enforcer, their workspace or tenant, members, invites, roles, API keys, or asks what they can do through the Enforcer MCP server.
---

# Enforcer

Enforcer is Instruxi's identity and authorization platform. This skill holds
only the ideas that rarely change. **Everything about specific endpoints comes
from the MCP server, never from memory**: the API changes, and a remembered
endpoint is how the old Enforcer skills went wrong.

## Look it up, don't recall it

The `enforcer` MCP server documents itself from the live spec:

1. `enforcer_api_search` — find an operation by domain noun ("invite",
   "api key", "role"), not by HTTP verb.
2. `enforcer_api_describe` — its parameters and shape.
3. `enforcer_api_read` for reads; `enforcer_api_write` for anything that
   changes state, which the user confirms first.

Prefer a dedicated workflow tool when one fits the question (tenant health,
customer lookup, transfer trace, ticket triage): one call instead of several.

## The model

- **Tenant** — a workspace. Every row belongs to exactly one; nothing crosses
  tenants unless a role says so. A tenant's `self_join_policy` decides whether
  people can join on their own or only by invite.
- **Account** — a person's membership in one tenant, with one role there.
  The same person can hold accounts in several tenants.
- **Role** — data, not a fixed list. Tenants can define their own, so read a
  role's permission grants (`tenant_read`, `tenant_write`, `tenant_manage`,
  `cross_tenant`), never infer power from its name.
- **Credential** — how a caller proves who it is: an OAuth sign-in
  (`/enforcer:login`) or an API key. Both act as the account they belong to.
- **Scope** — what a credential may do, *narrower* than the role. An OAuth
  sign-in and a scoped API key carry only the scopes they were granted; an
  unscoped key carries its account's whole role.

## When something is refused

- `401` — no credential, or an expired one. Run `/enforcer:login status`.
- `403` / `insufficient_scope` — the credential is real but not allowed. Call
  `enforcer_whoami` to see the account, role, grants and scopes in play before
  guessing; the fix is usually a scope or role, not a retry.
- Nothing comes back from a list you expected to see — check which tenant the
  credential belongs to (`enforcer_whoami`). Tenancy filters silently.

## Safety

- Writes go through `enforcer_api_write` and the user confirms each one. Never
  batch destructive operations without showing what they will touch.
- Never put an API key or token in a file, a command line or a message. Keys
  are revocable; say so if one may have leaked.
