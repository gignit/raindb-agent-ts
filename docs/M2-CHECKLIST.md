# Overview

## M2 progress log (newest first)

**Batch 4 landed (2026-05-09)** -- periscope. Tagged v0.4.0. **M2 COMPLETE.**

  - **Periscope** (G): all 18 read-only tools (status, formation_list/describe/lint, audit, reconcile, tier_list/describe/cursor, snapshot_list/get, pool_list, sentinels_list, events_list, catalog_metadata, catalog_tree, droplet_locate/residual). Note: the M2 checklist seed initially counted 17 -- the reference side actually returns 18 from the periscope returner (lint was tracked under the formation block in early drafts; it's a separate tool entry).

  Total batch 4: 18 new tools across 1 domain; 30 new unit tests; package now ships 70 of 70 tools (100% of non-deferred). Host application integration unchanged (all periscope tools are operator-tier).

**Final M2 tally**:
  - 70 tools shipped (M1: 2 pilots; M2 batches 1-4: 68 tools)
  - 3 tools deferred (filesystem-bound: pack_install, droplet_upload, droplet_download)
  - 161 unit tests across 13 test files; all passing
  - 14 domain catalogs + tenantTools aggregator
  - the host application's lifter selects 9 tools per the parity audit doc (all P0 marketplace + P1 formation introspection + droplet_create pilot); the rest stay package-only for the second consumer's M3 portal

**Batch 3 landed (2026-05-09)** -- catalog + query (sql/vector) + relay + digest. Tagged v0.3.0.

  - **Catalog** (E): catalog_list, catalog_tree, catalog_insert, catalog_update, catalog_delete, catalog_transfer. All 6 ported.
  - **Query** (F): sql_execute, vector_search. sql_execute has a SELECT-only guard that the reference side doesn't (LLM should not write data via SQL; rejects DDL/DML keywords client-side).
  - **Relay** (H): relay_queue, relay_status, relay_inspect, relay_logs, relay_tree, relay_entity. relay_queue + relay_entity walk listKeys directly (mirrors the reference ops); the others use readRelay GraphQL.
  - **Digest** (I): digest_list, digest_show. Mirrors the reference's action-status walker -- listDroplets to enumerate entities, listKeys per entity to find root relays, readRelay tree to project stages with start/complete/duration. Generic walker; action-type-specific walkers can land later.

  Total batch 3: 16 new tools across 4 domains; 34 new unit tests; package now ships 52 of ~70 tools (~74%). Host application integration unchanged (none of these tools are appropriate for the product surface per the parity audit doc).

**M2 remaining**: periscope (17 tools, all read-only) + droplet_upload/download (deferred per filesystem note).

**Batch 2 landed (2026-05-09)** -- droplet read-side + entity + key + llm + usage. Tagged v0.2.0.

  - **Droplet** (B): 9 tools (M1's droplet_create + read-side 5 + remaining mutating 3 + bulk 2). droplet_upload + droplet_download deferred.
  - **Entity** (C): all 6 lifecycle tools.
  - **Key** (M): all 3 (key_list, key_create, key_revoke).
  - **LLM** (K): all 3 tenant-scoped (llm_provider_list, llm_model_list, llm_usage_report_summary).
  - **Usage** (L): both tenant-scoped (usage_list, usage_summary).

  Total batch 2: 25 new tools; 43 new unit tests.

**Batch 1 landed (2026-05-09)** -- read-heavy low-risk domains, fully tested + lifted into the host application:

  - **Marketplace** (J): pack_info, pack_get, pack_features, vendor_list, vendor_info ported. pack_install deferred (filesystem-bound CLI primitive). Marketplace surface now complete except pack_install.
  - **Formation** (D): formation_list, formation_describe, formation_publish. All three.
  - **Cache** (O): cache_stats_my. Single tool; only tenant-scoped variant ported.
  - **Config** (N): config_get. Single tool. (Earlier checklist drafts mentioned config_list + config_set but they don't exist on the reference tenant tool table; removed from scope.)

  Total batch 1: 9 new tools across 4 domains; 35 new unit tests; package now ships 11 tools (M1's pack_list + droplet_create + batch 1's 9). The host application's lifter brings 8 of these onto its product surface (formation_publish kept admin-only on the shared package, not lifted into the host application per the parity audit doc).

**M2 remaining domains**: catalog, entity, query (sql+vector), periscope, relay, digest, llm, usage, key, plus droplet read-side (8 of 12 tools). See per-domain sections for the per-tool checklist.

---

M2 is mechanical bulk-port of the remaining ~68 tenant tools from the RainDB platform tool definitions into this package's `src/tools/<domain>.ts`.

**Why a checklist instead of a single big PR**: tools port one-at-a-time. Doing all 68 in one pass without per-tool tests means breakage compounds; doing them with tests as you go means each green test is a checkpoint. The scaffold + 2 pilots (M1) are already proven; M2 is just running the same template per tool.

**Per-tool work loop**:

  1. Read the reference via a coder query on the returner function `^<ToolNameTools>$` for context.
  2. Locate the specific tool entry by name within the returner body.
  3. Read the operation function it calls: coder query `^<OpsFn>$` to see the GraphQL operation + result shape.
  4. Read the result struct: coder query `^<ResultType>$` to know what to project.
  5. Translate to TypeScript in `src/tools/<domain>.ts`. Match name + parameters + ModifiesResource flag exactly.
  6. Add a unit test in `test/unit/<tool_name>.test.ts` (or a domain-bundled test file when the tools are tightly related).
  7. Update domain section state to `done` when the test passes.

**Domain ordering**: do read-heavy + low-cost domains first (config, cache, formation list/describe, marketplace remaining), then mid-tier (entity, relay, digest, llm, usage, key), then heavy (droplet, catalog, periscope, query). The high-value-per-line-of-code domains land first; periscope last because it has 17 tools and is the riskiest if the wire shape needs a fix.

**Live verification cadence**: after each 2-3 domains land, restart the host application and smoke-test one representative tool from each new domain in the chat UI. Catches schema drift early.

**Concurrent-edit awareness**: another agent is editing the RainDB API and the second consumer. If a GraphQL operation fails unexpectedly during M2 verification, first re-read the operation function against a fresh RainDB platform checkout to see if the schema selection set changed -- the fix is usually a 2-line update to the TS query string.

**Sections B-O** carry one entry per tool, each marked `pending` until ported. Mark a tool `in-progress` when you start it, `done` when its test passes against mocked GraphQL, and `deferred` if there's a reference-side issue that blocks it (note the issue inline).

**Section P** tracks the aggregator updates -- `tools/index.ts` and `src/index.ts` need a new entry every time a domain lands.

**Section Q** is the one-time pre-flight to run before starting any tool.

**Section R** is the copy-paste template every tool body follows.

# Domain droplet

**File**: `src/tools/droplet.ts` (extend existing). **Reference**: the tenant droplet returner + droplet/upload operations.

12 tools. `droplet_create` shipped in M1 -- mark `done`. The remaining 11 land here.

**Audit-doc note**: the parity audit flags droplet primitives as 'do NOT port' for the host application's product surface. The second consumer's portal SHOULD expose them (operators expect raw RainDB). The shared package builds them all; the host application's lifter opts out of all but `droplet_create` (the M1 pilot, also slated for removal in M2 once the pilot's verified the modifiesResource path).

## droplet_read_current

Read the current droplet for (formation, scope). Read-only. **minRole**: `read`. **modifiesResource**: false. **Required**: `formation`, `scope`.

## droplet_read_by_id

Read a specific droplet by UUID. Read-only. **minRole**: `read`. **modifiesResource**: false. **Required**: `formation`, `id`.

## droplet_read_latest

Read via index lookup (e.g. by-id-latest, by-email-latest). Read-only. **minRole**: `read`. **modifiesResource**: false. **Required**: `formation`, `index`, `value`.

## droplet_list

List structured droplet rows under a formation prefix. Read-only. **minRole**: `read`. **modifiesResource**: false. **Required**: `formation`. **Optional**: `prefix`, `pageSize` (default 100).

## droplet_keys

List raw S3 keys under a tenant-relative prefix (debugging tool). Read-only. **minRole**: `read`. **modifiesResource**: false. **Required**: `prefix`.

## droplet_create

Shipped in M1. **State**: done.

## droplet_update

Read-modify-write a droplet with CAS retry. Mutating. **minRole**: `write`. **modifiesResource**: true. **Required**: `formation`, `scope`, `changes`.

## droplet_push_public

Mirror a private droplet's float fields to the public bucket. Mutating. **minRole**: `write`. **modifiesResource**: true. **Required**: `formation`, `dropletId`.

## droplet_upload

**Decision: SKIP for the shared package in M2**. The reference reads `filePath` from the API host's local filesystem -- portal hosts have no operator filesystem. The base64 `fileData` path COULD work but is awkward at LLM-message scale (binary data in chat history). Defer until host-specific upload semantics settle. Mark `deferred`.

## droplet_download

**Decision: SKIP for the shared package in M2** for the same reason. Mark `deferred`.

## droplet_bulk_create

Create multiple droplets in one call. Mutating. **minRole**: `write`. **modifiesResource**: true. **Required**: `formation` + one of `entries` (array) or `filePath`. Skip the `filePath` arm here (filesystem-only); accept only `entries`.

## droplet_bulk_update

Update multiple droplets in one call (per-entry CAS retry). Mutating. **minRole**: `write`. **modifiesResource**: true. **Required**: `formation`, `scopeKey`, `entries`. Skip `filePath` for the same reason.

# Domain entity

**File**: `src/tools/entity.ts` (new). **Reference**: the tenant entity returner + entity operations.

6 tools.

## entity_version_history

List every version of an entity (newest first). Read-only. **minRole**: `read`. **modifiesResource**: false. **Required**: `formation`, `scopeValue`.

## entity_tag

Attach a tag to an entity. Mutating. **minRole**: `write`. **modifiesResource**: true. **Required**: `formation`, `scopeValue`, `tag`.

## entity_untag

Remove a tag. Mutating. **minRole**: `write`. **modifiesResource**: true. **Required**: `formation`, `scopeValue`, `tag`.

## entity_mark_for_expiration

Schedule an entity for soft-delete. Mutating. **minRole**: `write`. **modifiesResource**: true. **Required**: `formation`, `scopeValue`, `expireAt`.

## entity_cancel_expiration

Unschedule a pending expiration. Mutating. **minRole**: `write`. **modifiesResource**: true. **Required**: `formation`, `scopeValue`.

## entity_expire

Force-expire an entity now (skip the scheduler). Mutating. **minRole**: `admin` (destructive shortcut). **modifiesResource**: true. **Required**: `formation`, `scopeValue`.

# Domain formation

**File**: `src/tools/formation.ts` (new). **Reference**: the tenant formation returner + formation operations.

3 tools.

## formation_list

List formations available to the tenant. Read-only. **minRole**: `read`. **modifiesResource**: false.

## formation_describe

Full formation definition (config + JSON schema + indexes + tier policy + float config). Read-only. **minRole**: `read`. **modifiesResource**: false. **Required**: `formation`.

## formation_publish

Publish a new formation config + schema. Mutating. **minRole**: `admin`. **modifiesResource**: true. **Required**: `formationId`, `config`, `schema`, `schemaVersion`.

# Domain catalog

**File**: `src/tools/catalog.ts` (new). **Reference**: the tenant catalog returner + catalog operations.

6 tools. Catalog is RainDB's hierarchical-index primitive (the foundation under folder features).

## catalog_list

Flat list of catalog entries under a scope. Read-only. **minRole**: `read`. **modifiesResource**: false. **Required**: `formation`. **Optional**: `scopeValue`, `pageSize`.

## catalog_tree

Hierarchical tree view of catalog entries (depth-bounded). Read-only. **minRole**: `read`. **modifiesResource**: false. **Required**: `formation`. **Optional**: `catalogScopeValue`, `maxDepth`.

## catalog_insert

Insert a new catalog entry under a parent scope. Mutating. **minRole**: `write`. **modifiesResource**: true. **Required**: `formation`, `scopeValue`, `entry`.

## catalog_update

Update an existing catalog entry. Mutating. **minRole**: `write`. **modifiesResource**: true. **Required**: `formation`, `scopeValue`, `changes`.

## catalog_delete

Delete a catalog entry (with optional recursive). Mutating. **minRole**: `write`. **modifiesResource**: true. **Required**: `formation`, `scopeValue`. **Optional**: `recursive`.

## catalog_transfer

Move an entry between scopes (re-parent). Mutating. **minRole**: `write`. **modifiesResource**: true. **Required**: `formation`, `sourceScopeValue`, `targetScopeValue`.

# Domain query (sql + vector)

**File**: `src/tools/query.ts` (new). **Reference**: the tenant query returner + sql/vector operations.

2 tools.

## sql_execute

SQL SELECT against periscope's DuckDB executor. **minRole**: `read`. **modifiesResource**: false (per the audit doc's recommendation: enforce SELECT-only client-side; reject DDL/DML keywords before sending). **Required**: `query`. **Optional**: `formation` (scope to one formation's entity view).

**Note**: the reference side has no SELECT-only guard because operators run that interactively. The TS port adds a guard inside `execute()` that rejects any non-SELECT keyword (INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, GRANT, REVOKE) -- regardless of role -- because the agent should not be writing data via SQL; writes go through tool primitives. See the parity audit doc note.

## vector_search

Vector similarity search against an embedding-enabled formation. **minRole**: `read`. **modifiesResource**: false. **Required**: `formation`, `query` (text). **Optional**: `topK` (default 10), `filter` (mongo-style).

# Domain periscope

**File**: `src/tools/periscope.ts` (new). **Reference**: the tenant periscope returner + periscope operations.

17 tenant-scoped tools. Periscope is the SQL-plane observability surface (parquet pools + iceberg catalog + duckdb executor).

**All 17 are read-only.** None set `modifiesResource: true`. Triggering pool actions on demand (`raindb-admin periscope pool trigger`) is a pending admin feature. Land here when that ships on the reference side.

**minRole** for every tool: `read`.

## periscope_status

Cross-formation status overview for the tenant.

## periscope_formation_list

Formations with periscope tier policies.

## periscope_formation_describe

Full periscope config for one formation. **Required**: `formation`.

## periscope_formation_lint

Lint a formation's tier policy for misconfiguration. **Required**: `formation`.

## periscope_audit

Identify orphaned snapshot data per formation. **Required**: `formation`.

## periscope_reconcile

Arithmetic checks across the tier cascade for one formation. **Required**: `formation`.

## periscope_tier_list

Per-tier runtime state for one formation. **Required**: `formation`.

## periscope_tier_describe

Detailed tier state (cursor, pool count, byte total, storage). **Required**: `formation`, `tier`.

## periscope_tier_cursor

Current ingestion cursor for a tier. **Required**: `formation`, `tier`.

## periscope_snapshot_list

Iceberg snapshots for a formation+tier. **Required**: `formation`. **Optional**: `tier`.

## periscope_snapshot_get

One snapshot's full record. **Required**: `formation`, `snapshotId`.

## periscope_pool_list

Parquet pool files in a tier. **Required**: `formation`, `tier`.

## periscope_sentinels_list

Active + scheduled sentinels (lock state).

## periscope_events_list

Scheduled periscope.pool / periscope.expire events.

## periscope_catalog_metadata

Iceberg catalog metadata for a formation. **Required**: `formation`.

## periscope_catalog_tree

Iceberg catalog tree (manifests + data files). **Required**: `formation`.

## periscope_droplet_locate

Locate a dropletId in the periscope tier cascade. **Required**: `formation`, `dropletId`.

## periscope_droplet_residual

Count droplets past the tier cursor (ingestion lag). **Required**: `formation`. **Optional**: `tier`.

# Domain relay

**File**: `src/tools/relay.ts` (new). **Reference**: the tenant relay returner + relay operations.

6 tools, all read-only (relay observability).

## relay_queue

List pending + running relays. **minRole**: `read`. **modifiesResource**: false.

## relay_status

Status of one relay by id (state, attempts, last error). **minRole**: `read`. **modifiesResource**: false. **Required**: `relayId`.

## relay_inspect

Full relay record: input, output, all attempts, timing. **minRole**: `read`. **modifiesResource**: false. **Required**: `relayId`.

## relay_logs

Log lines emitted by a relay's handler invocations. **minRole**: `read`. **modifiesResource**: false. **Required**: `relayId`.

## relay_tree

Parent + child relay tree (digest extract -> chunk -> embed). **minRole**: `read`. **modifiesResource**: false. **Required**: `relayId`.

## relay_entity

All relays attached to one source entity (history of action invocations). **minRole**: `read`. **modifiesResource**: false. **Required**: `formation`, `entityId`.

# Domain digest

**File**: `src/tools/digest.ts` (new). **Reference**: the tenant digest returner + digest operations.

2 tools.

## digest_list

Digest pipeline status across one formation (per-document stage breakdown). Read-only. **minRole**: `read`. **modifiesResource**: false. **Required**: `formation`.

## digest_show

Digest stage detail for one entity (extract -> chunk -> enrich-block -> embed). Read-only. **minRole**: `read`. **modifiesResource**: false. **Required**: `formation`, `entityId`.

# Domain marketplace

**File**: `src/tools/marketplace.ts` (extend existing). **Reference**: the tenant marketplace returner + marketplace operations.

7 tools total. `pack_list` shipped in M1 -- mark `done`. The remaining 6 land here.

## pack_list

Shipped in M1. **State**: done.

## pack_info

Full pack record: metadata + README + features + every file inlined. Read-only. **minRole**: `read`. **modifiesResource**: false. **Required**: `vendor`, `packName`. **Optional**: `version` (empty=latest).

## pack_get

Alias for pack_info (CLI symmetry with `raindb-cli pack get`). Read-only. **minRole**: `read`. **modifiesResource**: false. Same parameter shape as pack_info.

## pack_features

Feature options a pack exposes (cargo-style installable units). Read-only. **minRole**: `read`. **modifiesResource**: false. **Required**: `vendor`, `packName`.

## pack_install

**Decision: SKIP for the shared package.** The reference writes files to `~/.local/share/raindb/packs/...` -- that's a CLI-host primitive. Portal hosts (both consumers) need a different semantic (publish formations into the tenant). Defer to a host-specific tool until product policy locks the semantic. Mark `deferred` with this rationale.

## vendor_list

List marketplace vendors. Read-only. **minRole**: `read`. **modifiesResource**: false. No required params.

## vendor_info

One vendor's identity record. Read-only. **minRole**: `read`. **modifiesResource**: false. **Required**: `vendorId`.

# Domain llm

**File**: `src/tools/llm.ts` (new). **Reference**: the tenant LLM returner + the platform LLM read paths. Admin variants (`llm_usage_report_reconcile`, `llm_usage_report_vendor`) excluded.

3 tools.

## llm_provider_list

List registered LLM providers. Read-only. **minRole**: `read`. **modifiesResource**: false.

## llm_model_list

List registered LLM models with capabilities + defaults. Read-only. **minRole**: `read`. **modifiesResource**: false.

## llm_usage_report_summary

This tenant's LLM token + cost usage grouped by model + date. Read-only. **minRole**: `read`. **modifiesResource**: false. **Optional**: `days` (lookback; 0=all-time, default 30).

# Domain usage

**File**: `src/tools/usage.ts` (new). **Reference**: the tenant usage returner + usage operations. Admin `*_all` variants excluded.

2 tools.

## usage_list

List raw usage events for the tenant (paginated, optional filters). Read-only. **minRole**: `read`. **modifiesResource**: false.

## usage_summary

Aggregated usage rollup (event counts, cost, by category). Read-only. **minRole**: `read`. **modifiesResource**: false.

# Domain key

**File**: `src/tools/key.ts` (new). **Reference**: the tenant key returner + key operations.

3 tools.

## key_list

List active API keys for the tenant. Read-only. **minRole**: `read`. **modifiesResource**: false.

## key_create

Mint a new API key for the tenant. Mutating. **minRole**: `admin` (key minting is sensitive). **modifiesResource**: true.

## key_revoke

Revoke an existing API key. Mutating. **minRole**: `admin`. **modifiesResource**: true.

# Domain config

**File**: `src/tools/config.ts` (new). **Reference**: the tenant config returner + config operations.

3 tools.

## config_get

Read a tenant service-config value. Read-only. **minRole**: `read`. **modifiesResource**: false.

## config_list

List all tenant service-config keys. Read-only. **minRole**: `read`. **modifiesResource**: false.

## config_set

Override a tenant service-config value. Mutating. **minRole**: `write`. **modifiesResource**: true.

# Domain cache

**File**: `src/tools/cache.ts` (new). **Reference**: the tenant cache returner.

1 tool. Admin variants (`cache_stats_tenant`, `cache_stats_all`) excluded -- those are admin-scoped.

## cache_stats_my

Object-cache hit/miss stats for the calling tenant. Read-only. **minRole**: `read`. **modifiesResource**: false.

# Aggregator + exports

**Two files** need updating each time a domain lands.

## tools/index.ts

- Import the new per-domain `<domain>Tools` array.
- Add it to the `tenantTools` aggregator. **Order matches the reference's `tenantToolTable`** (verify by reading `^tenantToolTable$`):
  1. dropletTools
  2. catalogTools
  3. entityTools
  4. sqlTools (alias for queryTools' SQL-only subset, OR keep `queryTools` here -- pick one and stay consistent)
  5. formationTools
  6. cacheTools
  7. periscopeTools
  8. keyTools
  9. configTools
  10. usageTools
  11. relayTools
  12. digestTools
  13. llmTools
  14. marketplaceTools
- Remove the `// -- M2` comments as each domain lands.
- Re-export the per-domain const + the named tools (the README's public-API contract).

## src/index.ts

- Add named exports for every new tool const (e.g. `pack_info`, `droplet_update`, ...).
- Add the per-domain catalog re-export (e.g. `catalogTools`, `entityTools`, ...).
- Add the result-type re-exports when the tool's result has a public shape worth exposing.

## smoke.test.ts

- For each new domain: add an assertion that `agent.<domainTools>` is an Array, and `tenantTools` includes the domain's representative tool name. The smoke test is the public-API contract; new exports MUST land here so removals break it.

# Pre-flight checklist (one-time before M2 starts)

Run these ONCE at the start of M2. They confirm the surfaces M2 builds against haven't drifted since M1 landed.

- [ ] Read `^tenantToolTable$` in `<raindb-platform-checkout>` -- confirm the reference aggregator's domain composition matches the per-domain sections of this checklist. If a new domain landed on the reference side, add a section here.
- [ ] Read `^Registration$` in `<raindb-platform-checkout>` -- confirm the reference `Registration` type still has the same field set we mirrored in `src/registry/types.ts::RegisteredTool`. Field additions on the reference side need to land here first.
- [ ] Read `^ToolParameters$|^ToolProperty$` in `<raindb-platform-checkout>` -- confirm the schema struct fields haven't grown.
- [ ] `cd ~/src/raindb-agent-ts && npm run typecheck && npm test` -- confirm M1 is still green before starting M2.
- [ ] `cd <host-application-server> && npm run typecheck` -- confirm the host application still consumes the package cleanly.
- [ ] Live: open the host application's chat UI, ask "what marketplace packs are available?", verify pack_list fires + returns data. **Do not start M2 until this passes** (per the README's "stop and verify before proceeding" gate).

If any of the above fails, fix the failure first. Don't paper over schema drift by hardcoding shapes -- the wire contract is the contract.

# Per-tool template

**Per-tool work pattern** (every tool follows this; copy it).

```
Step 1: Read the reference
  Query the returner function `^<DomainTools>$` in <raindb-platform-checkout>.
  -- find the entry for this tool's Name in the body. Note:
     name, description, parameters, required-list, ModifiesResource.

Step 2: Read the operation function the tool calls
  Query `^<OpsFn>$` in <raindb-platform-checkout>.
  -- read the GraphQL operation string + result projection.

Step 3: Read the result struct
  Query `^<ResultType>$` in <raindb-platform-checkout>.
  -- know what fields to project in TypeScript.

Step 4: Translate to TS in src/tools/<domain>.ts
  Append a new RegisteredTool const + add it to the per-domain
  array. Match the reference shape exactly:
    - Name: same string (snake_case)
    - Description: same text (or close paraphrase if the reference
      side uses taglines that should NOT cross over -- see G7 in
      the operating manual).
    - parameters: same property names + types + required-list.
    - modifiesResource: true iff the reference side has it.
    - minRole: 'read' for read-only, 'write' for mutating,
      'admin' for platform-scope tools (rare in tenant tools).
  GraphQL op: build the query string verbatim from the reference
  operation function. Mirror the selection set field-for-field.

Step 5: Test
  test/unit/<tool_name>.test.ts (or a domain-bundled file).
  Mock fetch (see test/unit/pack_list.test.ts as template):
    - One test for the wire shape (query + variables emitted).
    - One test for happy-path result projection.
    - One test for required-arg validation when applicable.
    - One test for the metadata-parity check (name, minRole,
      modifiesResource, parameters).

Step 6: Wire into aggregator
  src/tools/index.ts -- add to the per-domain const array.
  src/index.ts -- re-export the named tool + the per-domain array.

Step 7: Verify
  cd ~/src/raindb-agent-ts && npm run typecheck && npm test
  -- must stay green every step.

Step 8: Update this checklist
  Mark this tool's sub-section state = 'done'.
  When the whole domain is ported, mark the parent section = 'done'.
```

**Test file template** (mirror of `test/unit/pack_list.test.ts`):

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { <toolName> } from '../../src/tools/<domain>.js';
import type { ToolContext } from '../../src/registry/types.js';

function mockFetch(body: unknown, recorder: Array<{url:string;body:any}>): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    recorder.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(body), { status: 200, headers: {'Content-Type':'application/json'} });
  };
}

function ctx(): ToolContext {
  return { creds: { apiKey: 'rdb_test', endpoint: 'http://localhost:8080/graphql' }, role: 'read' };
}

test('<toolName>: emits expected GraphQL operation', async () => {
  const recorder: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: { /* ... */ } }, recorder);
  try {
    await <toolName>.execute(ctx(), { /* ... */ });
    assert.equal(recorder.length, 1);
    assert.match(recorder[0].body.query, /<operation_name>/);
    /* further wire-shape assertions */
  } finally {
    globalThis.fetch = original;
  }
});

test('<toolName>: tool metadata matches reference', () => {
  assert.equal(<toolName>.name, '<tool_name>');
  assert.equal(<toolName>.minRole, '<read|write|admin>');
  /* modifiesResource, parameters.required, etc. */
});
```

**Common pitfalls** (saw these in M1):

  - Don't pass `dir` to GET commands (single-symbol coder lookups) -- they search globally by name.
  - Don't use glob syntax (`handle*`) in selectors -- coder uses regex (`^handle.*`).
  - `assert.notOk` doesn't exist in node:assert/strict -- use `assert.ok(!...)`.
  - When mocking fetch, restore in a `try/finally` -- otherwise a failing test leaks the mock to subsequent tests in the same process.
  - Some tools have args that are objects/arrays, not just strings/ints. Use `objectArg(args, 'name')` for `Record<string, unknown>` and check for null. Use `Array.isArray` after pulling raw, since `stringSliceArg` filters non-strings -- if you need a generic any[], extract it directly.
