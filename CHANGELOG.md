# Changelog

All notable changes to `@raindb/agent` are documented here. The
package follows semver post-1.0; pre-1.0 minor bumps may include
breaking changes (rare, called out explicitly).

## 0.8.1 -- tool fixes against the live RainDB API

Every read-only tool was exercised against a live tenant; these were
returning empty or wrong results.

### Fixed

- **SQL rows.** `SQLResult.rows` is a list of objects keyed by column.
  `executeSQL` decoded every row to `[]`; it now projects each row in
  `columns` order (nested values JSON-encoded) and fails loudly on any
  other row shape. Affects `sql_execute`, `usage_*` and
  `llm_usage_report_summary`.
- **Index name `by-id-latest`.** Formations declare `by-id`; the API
  rejects `by-id-latest`. `droplet_update`, `droplet_bulk_update`,
  `llm_model_list`, `llm_provider_list` and `index_page` used it.
- **`index_page`** selected `Droplet.scopeValue`, which does not exist,
  so every lookup failed and the page was always empty. It now returns
  an error when no key on a page resolves instead of an empty page.
- **Relay layout.** `relay_entity`, `digest_list` and `digest_show`
  listed `relays/<formation>/<entity>/`; relays live under
  `entities/<formation>/<entity>/relays/`.
- **Usage table.** `usage_*` and `llm_usage_report_summary` queried
  `entity."platform_usage_event"`; the table is
  `entity."platform-usage-event"`.
- **Host transport.** `llm_*`, `digest_*` and `relay_*` made some
  GraphQL calls without the injected host, which fails inside a bolt.
- **`llm_model_list` / `llm_provider_list`** return the first error when
  every entry fails to read, instead of an empty list.

### Changed

- **Marketplace tools** no longer require `ctx.marketplaceBaseUrl`; they
  use the API origin of `ctx.creds.endpoint`, which serves
  `/api/marketplace/*`. Set `marketplaceBaseUrl` only for a separate
  marketplace origin.

## 0.8.0 -- RainDB wire reconciliation

Reconciliation against the current RainDB GraphQL surface. The full
wire delta since the last reconcile is additive-only -- no field the
SDK decodes was removed or retyped (verified against every consumed
SDL type). No breaking changes. This release ADOPTS new additive
capabilities for parity with the RainDB CLI/MCP surface.

### Added

- **SQL freshness bridge.** `executeSQL` now selects + decodes
  `SQLResult.truncated` and the per-formation `latest` freshness
  bookmark (`FormationLatest`: `snapshotDropletId`, `snapshotKey`,
  `snapshotAt` as Unix-MS number, `currentDropletId`, `currentKey`,
  `indexPrefix`, `freshnessStatus`). The SQL plane is eventually
  consistent; `latest[].freshnessStatus === 'BEHIND'` signals that
  the snapshot predates the newest writes. Callers that need those
  writes can optionally fetch them with `droplet_since`
  (`after=latest[].snapshotKey`); it is never required.
  `sql_execute` documents this. New exports: `FreshnessStatus`,
  `FormationLatest`.
- **`sql_execute` / `executeSQL` `planStrategy`** (`range` | `scan`)
  -- per-query view-preparation planner override
  (`SQLInput.planStrategy`). `executeSQL` gains an optional
  `ExecuteSQLOptions` trailing arg (source-compatible with existing
  positional callers).
- **`periscope_status` `pending` flag** + in-flight fields. The tool
  now accepts `pending: boolean` and selects `behind`,
  `dropletsAhead`, `dropletsAheadHasMore`, `inflight`,
  `snapshotCursor`, `currentCursor`, `sourceIndexPrefix` -- parity
  with the MCP `periscope_status` tool.
- **`droplet_list` `scopeValue`** passthrough
  (`ListDropletsInput.scopeValue`) -- resolves a semantic entity
  scope server-side before the LIST.

### Changed

- `formation_describe` description updated: `config` is the
  fully-resolved config with the manifest-driven `features` section
  (the bolted-on capabilities block was removed upstream).

### Fixed

- `relay_digest` unit test asserted the pre-fix `relays/queue/`
  prefix; corrected to the shipped `indexes/<queue>/by-formation/`
  prefix (production code was already correct since 6ad263b) and
  updated the mock `KeyEntry.lastModified` fixtures from RFC3339
  strings to Unix-MS numbers to match the `Time!` wire contract.

## 0.6.0 -- host-adapter

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

### Migration guide for consumers

**Node BFF consumers**: a host application's BFF that currently
imports `makeRaindbAiClient` from its agent-loop service should
update the import to `makeNodeHost(creds).chatCompletion(req)`.
When porting the same app to a Lightning bolt, the import is
removed entirely -- the bolt host injects `host.chatCompletion`
through the bolt sandbox.

**New consumers**: construct your `ToolContext` with
`host: makeNodeHost(creds)` from day one. No migration needed --
the host pattern is the only path that exists for new consumers.

### Why this changed

RainDB Lightning bolts run in the bolt sandbox, which does not have
a Node runtime: no `globalThis.fetch`, no ability to load
`openai-node`. The pre-v0.6 package required both, so bolts couldn't
use it. The host abstraction lets bolts inject their own transport
(the bolt sandbox's `ctx.fetch` + a chat-completion adapter
implemented per-consumer, wired up in your bolt's agent-host module)
while Node consumers continue using `makeNodeHost` with no behavior
change.

The host implementation lives in the consumer, NOT in this package.
Each consumer's runtime (Node `globalThis.fetch`, the bolt sandbox's
`ctx.fetch`, or a future runtime's equivalent) is the consumer's
concern; this package's surface stays runtime-agnostic.

Two consumer shapes today: a host application's Node BFF and the
Lightning bolt port of that same app (the bolt sandbox). The
package's surface accommodates both without runtime-specific
branches in shared code.

---

## 0.5.0 -- pre-host-adapter baseline

Last release with the Node-only architecture. `runAgent`
constructed an `openai-node` client internally via
`makeRaindbAiClient`; `ToolContext` had no `host` field. All
HTTP calls used `globalThis.fetch` directly.
