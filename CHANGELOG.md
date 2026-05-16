# Changelog

All notable changes to `@raindb/agent` are documented here. The
package follows semver post-1.0; pre-1.0 minor bumps may include
breaking changes (rare, called out explicitly).

## Unreleased -- goja-host-adapter (will become 0.6.0)

### Breaking

- `ToolContext.host: AgentHost` is now a required field. Consumers
  that construct `ToolContext` literals must pass `host` explicitly.
  The most common shape:

  ```typescript
  import { makeNodeHost } from '@raindb/agent';
  const ctx = {
    creds,
    host: makeNodeHost(creds),
    role: 'read',
  };
  ```

  Pre-v0.6 callers' build will fail with `Property 'host' is missing
  in type ...`. Fix: import `makeNodeHost` and inject it.

- `makeRaindbAiClient` removed from the public API. Callers that
  needed it now call `ctx.host.chatCompletion(req)`; the Node host
  (`makeNodeHost`) wraps `openai-node` internally, so the network
  behavior is unchanged. Migration:

  ```typescript
  // before
  import { makeRaindbAiClient } from '@raindb/agent';
  const ai = makeRaindbAiClient(creds);
  const completion = await ai.chat.completions.create(req);

  // after
  import { makeNodeHost } from '@raindb/agent';
  const host = makeNodeHost(creds);
  const completion = await host.chatCompletion(req);
  ```

### Added

- `AgentHost` interface in `src/host/types.ts`. Two methods plus
  `log`: `fetch(url, init?)`, `chatCompletion(req)`,
  `log.{info,warn,error}(msg, fields?)`. Hosts inject this into
  `ToolContext.host`.
- `makeNodeHost(creds)` -- the Node host implementation. Wraps
  `globalThis.fetch` and `openai-node`. Exported from the root.
- `ensureHost(ctx)` -- normalizer that returns a ctx with `host`
  filled from `makeNodeHost(ctx.creds)` when absent. Used internally
  by the migration shim path; consumers can call it too.
- `HostResponse`, `HostFetchInit`, plus the
  `ChatCompletion*` family of request/response shapes (mirror
  OpenAI's wire format with snake_case fields preserved).
- Mock-host integration tests in `test/unit/host_adapter.test.ts`
  proving runAgent drives end-to-end through a hand-rolled host
  with zero global-fetch involvement.

### Changed

- `executeGraphQL`, `executeSQL`, `fetchMarketplace`, and every
  tool's GraphQL invocation now route through `ctx.host.fetch`.
  When called without a `host` argument, the helpers fall back to
  a Node host built inline -- preserves the existing Node behavior
  for callers that haven't migrated yet.
- `resolveDefaultModel` and `resolveDefaultChatModel` accept an
  optional `host` parameter. When passed, the GraphQL
  `llmRegistry` query goes through that host transport.
- `runAgent` calls `ensureHost(opts.ctx)` at entry. Node consumers
  who didn't pre-populate host get a Node host auto-filled;
  pre-populated host (bolt path, test mocks) passes through.

### Removed

- `makeRaindbAiClient` (replaced by `ctx.host.chatCompletion`).

### Migration guide for the two known consumers

**fdn-app** (`~/src/fdn-app`): the BFF currently imports
`makeRaindbAiClient` from `services/agentLoop.ts`. On the
`lightning-port` branch (the Lightning bolt port), the import is
removed entirely -- the bolt host injects `host.chatCompletion`
through the goja sandbox. On the main branch (Node BFF), update
the import to `makeNodeHost(creds).chatCompletion(req)`.

**raindb-app** (`~/src/raindb-app`): when it consumes this package
(scheduled milestone M3), construct its `ToolContext` with
`host: makeNodeHost(creds)` from day one. No migration needed --
the host pattern is the only path that exists for new consumers.

### Why this changed

Lightning bolts (raindb-phoenix-lightning) run in goja sandboxes
which do not have a Node runtime: no `globalThis.fetch`, no ability
to load `openai-node`. The pre-v0.6 package required both, so
bolts couldn't use it. The host abstraction lets bolts inject
their own transport (goja `ctx.fetch` + a Go-built chat-completion
adapter) while Node consumers continue using `makeNodeHost` with
no behavior change.

Two known consumers today: `fdn-app` (Node BFF) and the Lightning
bolt port of fdn-app (goja sandbox). The package's surface accommodates
both without runtime-specific branches in shared code.

---

## 0.5.0 -- pre-host-adapter baseline

Last release with the Node-only architecture. `runAgent`
constructed an `openai-node` client internally via
`makeRaindbAiClient`; `ToolContext` had no `host` field. All
HTTP calls used `globalThis.fetch` directly.
