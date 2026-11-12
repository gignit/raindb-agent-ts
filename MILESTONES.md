# raindb-agent-ts -- internal milestone handoff

> **If you're here to BUILD AN APP on RainDB, read [README.md](./README.md)
> instead.** That doc is the Quickstart + How-to + Troubleshooting guide
> for app authors -- short, copy-pasteable, no assumed knowledge.
>
> This document (MILESTONES.md) is the internal handoff for the agent
> actively porting the raindb-agent-ts package itself from its
> reference implementation (~68 tools across Milestones 1-3). If you're
> not doing that specific port, you don't need this doc.

---

> ## Agent: start here
>
> You are working on `@raindb/agent` -- a shared TypeScript agent
> runtime + tool catalog. Two consumers: a host application and a
> Node consumer. The reference implementation is the RainDB
> platform agent; this package is its TypeScript mirror. Your
> goal is full **raindb-cli parity** for the TypeScript portals.
>
> **Sequence:**
>
> 1. Read this README end-to-end. The "Read these BEFORE writing
>    any code" section names the four other docs you must read
>    before touching code. Do not skip them.
>
> 2. Land **Milestone 1** (skeleton + 2 reference tools verified
>    end-to-end against a host application). Stop and verify before
>    proceeding. Do NOT bulk-port tools yet.
>
> 3. Land **Milestone 2** (the remaining ~68 tools) once the
>    pattern from Milestone 1 is proven. Each tool is a
>    mechanical translation of its reference; do not redesign.
>
> 4. Land **Milestone 3** in the second consumer: add the agent
>    server endpoint + client UI consuming this package, mounting
>    the same `tenantTools` array the first host uses. **This is when
>    the user's stated goal is achieved.**
>
> **Every tool must mirror its reference counterpart** exactly: same
> name (snake_case), same parameters, same `ModifiesResource`
> flag, same description text. The model treats the reference and TS
> surfaces as substitutable. Don't rename, don't "improve", don't
> add tools that don't exist on the reference side.
>
> **Use `coder` MCP tools for all code reading.** The "Coder MCP"
> section below has the cheat sheet, the discovery sequence for
> each new domain, and the power patterns for this work. Read
> it. The reference is a large codebase; coder is the only
> efficient way to navigate it.
>
> **Don't break the public API once the host application installs
> the package.** The `src/index.ts` exports are contractual.
>
> Verification checklist + reporting protocol at the bottom of
> this file. Update the Status section when each milestone lands.

---

Shared TypeScript agent package for the RainDB ecosystem.
Two consumers: a host application and a Node consumer. Both
import the same agent runtime, the same ~70 tenant tools, and a
common system-prompt builder so the agent surface is identical
across the two products.

The RainDB platform agent is the reference implementation. This
package is a TypeScript mirror.

---

## Status: Milestone 1 done -- ready for live verification + M2 bulk port

| Component | State |
|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.test.json`, `.gitignore` | Done |
| `src/index.ts` (full public API) | Done |
| `test/unit/{smoke,pack_list,droplet_create,loop}.test.ts` (23 tests) | Done |
| `npm install`, `npm run typecheck`, `npm run build`, `npm run test` | All clean |
| `runAgent`, types, GraphQL client, openai client, registry helpers, system-prompt scaffold | Done (M1) |
| Pilot tools `pack_list` + `droplet_create` | Done (M1) |
| Host application consumption (file: dep + adapter) | Done (M1) |
| Live verification in the host application UI against test-tenant | **Next -- before M2** |
| Remaining ~68 tool implementations | **Pending Milestone 2** |
| Second consumer consumption | **Pending Milestone 3** |

**v0.1.0 tagged.**

The host application now imports the two pilot tools via
`file:../../raindb-agent-ts`. At runtime `ALL_TOOLS` has 15
entries: 13 host product tools + 2 shared (`pack_list` at
minRole=`read`, `droplet_create` at minRole=`update`). The role
adapter lives in the host application's server services.

The toolchain matches the host application's server exactly:
TypeScript 5.6, Node 20, ESM, `module: NodeNext`, `node --test`
runner with `tsx` import. No ESLint -- typecheck IS the lint,
same as the host. No vitest -- `node:test` is the runner, same
as the host.

Run `npm install && npm test` to verify the scaffold works on
your machine before starting Milestone 1.

---

## Read these BEFORE writing any code

1. **The agent tool parity audit** -- the audit that motivated
   this package. Lists every raindb-cli tool, what the host
   application has today, and which tools to port at which
   priority. The package's tool catalog mirrors that audit.

2. **The agent operating manual** -- the operating manual for
   the reference side. The TypeScript port preserves the same
   conventions: 3-arm output dispatch (consumer side), one
   operation call per tool, naming convention `<domain>_<verb>`
   snake_case. Read the Output System and AI Tool Surface
   sections; the same patterns apply here.

3. **The `Registration` reference type** -- the struct that this
   package's `RegisteredTool` TypeScript type must mirror
   exactly. The wire shape sent to the model has to match
   between the reference and TS.

4. **The reference agent loop** -- the reference agent loop. The
   TypeScript `runAgent` already exists in the host application's
   server services; you are extracting it, not rewriting from
   scratch.

5. **The host application's tool declarations** -- how the host
   declares a `RegisteredTool` today (parameters JSON Schema,
   `execute(ctx, args)` shape). Your tool ports follow this
   pattern.

---

## Coder MCP -- the only way you read the reference

Don't grep. Don't cat. Don't Read large files line-by-line.
The reference is a large codebase; coder is the AST-aware,
token-efficient way to navigate it. The Go and TypeScript
extensions are language-correct -- coder knows what a
`Registration` is, what methods belong to a receiver, what
calls a function.

Every coder call accepts `cwd=<path>` to scope to a repo, so
you'll prefix every query with `cwd=<raindb-platform-checkout>`
when you're reading the reference. Drop `cwd` for the local
package (this repo).

### Cheat sheet -- the queries you will use most

| Goal | Tool |
|---|---|
| Read one function's full body | inspect the reference by symbol name, scoped with `cwd=...` |
| Read multiple in one call (regex OR comma-list) | select by regex or comma-list of names |
| Read all funcs in a tool returner file | select `^tenant.*Tools$` or `^admin.*Tools$` |
| Read a struct/type | select the type by name |
| Find what calls a function | callers query by name |
| Find every reference to a symbol | references query by name |
| Whole-codebase landscape (no dir) | snapshot scoped with `cwd=...` |
| One package's contents | snapshot scoped to a directory |
| All functions in a directory | functions query scoped to a directory |
| Imports + dependency layer check | dependencies query scoped to a directory |
| Catch your own mistakes after edits | duplicates + parse-error queries |

Every reference coder response **auto-appends** PARSE ERRORS
and DUPLICATE DEFINITIONS sections at the bottom when problems
exist. After any structural change you make on the reference
side (rare in this work, but possible), check the bottom of the
next coder response. Don't ignore it.

### Power patterns specific to this work

You're translating ~70 tools from the reference to TypeScript.
The reference files follow a strict shape: each tool-domain file
exports one returner function `tenantXTools(...) []Registration`
whose body is a literal `return []Registration{ {...}, {...} }`.
Each `Registration` has `Name`, `Description`, `Schema`,
`Invoke`, optional `ModifiesResource`. That's the unit you're
translating.

**To read a whole tool domain at once:** query the returner
function (e.g. `^tenantMarketplaceTools$`) with all annotations
enabled (comments, jsdoc-equivalent, decorator metadata) so you
see the full intent.

**To enumerate every operation function a domain calls (so you
know what GraphQL operations to mirror in TS):** query the
returner function, read the body; every operation-function call
is a TypeScript port target. Then for each, query that operation
function (e.g. `^PackList$`) with annotations enabled -- it shows
you the GraphQL operation it builds + the result shape. Mirror
both in TypeScript.

**To trace from a tool name to its GraphQL wire format:**

```
1. query the returner function `^<ToolName>Tools$`  -- find Invoke body
2. query the operation function `^<OpsFn>$`          -- read the operation func
3. find callers of the raw GraphQL helper            -- find GraphQL helper
4. Read the operation string in the ops func body    -- that's your TS query
```

**To verify your TypeScript translation matches the reference
shape:** read the TS function in this repo, then read the
returner function on the reference side scoped with
`cwd=<raindb-platform-checkout>`. Visually diff parameter names,
required-list, ModifiesResource flag, and result projection. The
two should be substitutable from the model's perspective.

### Discovery sequence for a new domain

When porting `tools_<domain>.ts`, run these in order before
writing any TS:

1. Query the returner functions `^tenant<X>Tools$` and
   `^admin<X>Tools$` scoped with `cwd=<raindb-platform-checkout>`
   -- enumerate every tool in the domain. Note: name,
   description, parameters, ModifiesResource flag, operation
   function called.
2. For each operation function called: query `^<OpsFn>$` with
   annotations enabled -- read the GraphQL operation + result
   shape.
3. Query the result type `^<ResultType>$` -- read the result
   struct so you know what to project in TypeScript.

Now you have the full mapping. Translate to TS in one pass.

### What NOT to do with coder

- **Don't pass `dir` to GET commands** (single-symbol lookups).
  They search globally by name. `dir` only narrows FIND commands
  (list queries).
- **Don't use glob syntax** (`handle*`). coder uses regex. Use
  `^handle.*` or `handle.*$` instead.
- **Don't read reference source files with the Read tool.**
  They're in another repo and the LSP fights you. Use the
  symbol-scoped coder queries instead.
- **Don't read whole files via a symbol selector matching the
  file name.** That's not what selectors do; you'll get nothing.
  Match by symbol name.
- **Don't trust the LSP errors that show up when you Read or Edit
  reference source files.** The reference's toolchain setup
  confuses the LSP into reporting `cannot find package` for
  legitimate intra-project imports. The coder parse-error query
  is the source of truth.

### Refresher

Run the coder Go guide once at session start to refresh the full
guide. Don't memorize it; just know it's there. The five-tier
mental model (FIND -> GET -> RELATIONSHIP -> ANNOTATE ->
FILTERS) plus the SELECTOR rules are 90% of what you need.

---

## Plan: structure first, then bulk-port

You will be tempted to write all 70 tools immediately. **Don't.**
The right sequence is structure-first, prove-the-shape with two
representative tools, then bulk-port. This catches design
mistakes once, not 70 times.

### Milestone 1 -- Skeleton + 2 reference tools (target: 1 day)

Goal: a working package that the host application can install and
use, with exactly two tools live, both verified end-to-end
against the RainDB API.

Tasks:

- ~~Initialize `package.json`, `tsconfig.json`, ESLint, vitest~~
  **Done in scaffold commit. See "Status" above. The toolchain
  matches the host application's server exactly: TypeScript 5.6,
  Node 20, ESM with NodeNext, `node:test` runner via `tsx`. No
  ESLint (typecheck is the lint). No vitest (`node:test` is the
  runner).**
- Extract `runAgent`, `RegisteredTool`, `ToolContext`,
  `AgentEvent`, `ToolEvent`, `AgentResult` from the host
  application's server agent loop + tool declarations. The
  extraction is mechanical: copy the types, copy the loop, fix
  imports.
- Extract the openai-spec HTTP client from the host application's
  server into `src/client/raindbAi.ts`. Preserve every option the
  host passes (apiKey, base URL resolution).
- Extract the GraphQL wrapper from the host application's server
  (the `executeGraphQL` function and `GraphQLOptions` type) into
  `src/client/graphql.ts`. This is what every tool calls.
- Implement the public API shape (see below).
- **Implement two reference tools end-to-end:**
  - `pack_list` (read-only, proves marketplace + bridge
    dispatch works; references the marketplace returner
    function's `pack_list` entry)
  - `droplet_create` (mutating, proves `ModifiesResource: true`
    flows through the agent loop's confirm path; references the
    droplet returner function's `droplet_create` entry)
  - Each tool gets a unit test (mocked GraphQL) and a comment
    pointing at its reference.
- Update the host application's server tool declarations to
  import `pack_list` and `droplet_create` from `@raindb/agent`.
  Verify in the live host UI: log in, ask the agent "what
  marketplace packs are available?", confirm `pack_list` fires
  and returns data.
- Tag `v0.1.0`, push, **stop here and verify before
  proceeding to Milestone 2**.

### Milestone 2 -- Bulk tool port (target: 3-4 days)

Once Milestone 1 is verified, port all remaining tools. The
shape is proven; this is mechanical translation.

Each `src/tools/<domain>.ts` file mirrors its reference
counterpart 1:1. Tool names match exactly (snake_case, same
string). Parameters match exactly (same names, same types, same
required-list). The only thing different is the body: the
reference calls an operation function, TypeScript calls
`executeGraphQL(creds, ...)`.

Domains to port (use the audit doc for the per-domain
priority):

- `droplet.ts` -- 12 tools: `droplet_read_current`,
  `droplet_read_by_id`, `droplet_read_latest`, `droplet_list`,
  `droplet_keys`, `droplet_create`, `droplet_update`,
  `droplet_push_public`, `droplet_upload`, `droplet_download`,
  `droplet_bulk_create`, `droplet_bulk_update`
- `entity.ts` -- 6 tools: `entity_version_history`,
  `entity_tag`, `entity_untag`, `entity_mark_for_expiration`,
  `entity_cancel_expiration`, `entity_expire`
- `formation.ts` -- 3 tools: `formation_list`,
  `formation_describe`, `formation_publish`
- `catalog.ts` -- 6 tools: `catalog_list`, `catalog_tree`,
  `catalog_insert`, `catalog_update`, `catalog_delete`,
  `catalog_transfer`
- `sql.ts` -- 2 tools: `sql_execute`, `vector_search`
- `periscope.ts` -- 17 tools: `periscope_status`,
  `periscope_formation_list`, `periscope_formation_describe`,
  `periscope_formation_lint`, `periscope_audit`,
  `periscope_reconcile`, `periscope_tier_list`,
  `periscope_tier_describe`, `periscope_tier_cursor`,
  `periscope_snapshot_list`, `periscope_snapshot_get`,
  `periscope_pool_list`, `periscope_sentinels_list`,
  `periscope_events_list`, `periscope_catalog_metadata`,
  `periscope_catalog_tree`, `periscope_droplet_locate`,
  `periscope_droplet_residual`
- `relay.ts` -- 6 tools: `relay_queue`, `relay_status`,
  `relay_inspect`, `relay_logs`, `relay_tree`, `relay_entity`
- `digest.ts` -- 2 tools: `digest_list`, `digest_show`
- `marketplace.ts` -- 6 tools (already has `pack_list` from
  Milestone 1; add `pack_info`, `pack_get`, `pack_features`,
  `pack_install`, `vendor_list`, `vendor_info`)
- `llm.ts` -- 3 tools: `llm_provider_list`, `llm_model_list`,
  `llm_usage_report_summary`
- `usage.ts` -- 2 tools: `usage_list`, `usage_summary`
- `key.ts` -- 3 tools: `key_list`, `key_create`, `key_revoke`
- `config.ts` -- 1 tool: `config_get`
- `cache.ts` -- 1 tool: `cache_stats_my`

Per-tool checklist:
1. Read the reference via a symbol-scoped coder query.
2. Translate to TypeScript preserving exact name + parameter
   shape + ModifiesResource flag.
3. Replace the reference operation call with the equivalent
   `executeGraphQL(creds, query, variables)` call. The GraphQL
   operations are already implemented server-side in the RainDB
   platform; you're constructing the same operation from the TS
   side.
4. Add a unit test against a mocked `executeGraphQL`.
5. Move on. Do not refactor the reference. Do not
   "improve" the tool semantics.

When all tools are ported, tag `v0.2.0`, update the host
application to consume the full set, verify in the live UI.

### Milestone 3 -- second consumer (target: 1 day)

Once Milestones 1 + 2 are stable, **stop and switch to the
second consumer**. That repo's server has no agent today;
your job is to add one that mirrors the first host's:

- Add `@raindb/agent` to the second consumer's server
  `package.json`.
- Create the second consumer's server agent module: wires
  `runAgent`, mounts `tenantTools`, builds a consumer-specific
  system prompt.
- Add a server route: `POST /api/ai/chat` that streams
  agent events (SSE, matching the first host's wire shape).
- Add a client surface: a chat component wherever the portal
  puts components. The shape can match the first host's chat UI;
  if there's an opportunity to share client components later,
  that's a future package.
- The system prompt should focus on RainDB-platform tasks
  (group management, tenant CRUD, marketplace browsing,
  formation publishing) -- NOT the first host's product tasks
  (folders, documents).
- Verify: log into the second consumer, ask "what packs are
  available?", confirm `pack_list` fires through the agent.

When this milestone lands, both apps have full raindb-cli
parity. The user's stated goal is achieved.

---

## Public API the package exports

This is the contract. Two consumers bind to it; changing it is a
breaking change.

```typescript
// @raindb/agent

// === Agent runtime ===
export { runAgent } from './loop';
export type {
  RunAgentOptions,
  AgentResult,
  AgentEvent,
  ToolEvent,
} from './loop';

// === Registry primitives ===
export type {
  RegisteredTool,
  ToolContext,
  ToolRole,
  GraphQLOptions,
} from './registry/types';
export { buildToolDefs } from './registry/build';

// === System prompt ===
export {
  buildSystemPrompt,
  type SystemPromptOptions,
  type SystemPromptBase,
} from './prompts/system';

// === Tool sets (per-domain arrays for composable host catalogs) ===
export {
  dropletTools,
  entityTools,
  formationTools,
  catalogTools,
  sqlTools,
  periscopeTools,
  relayTools,
  digestTools,
  marketplaceTools,
  llmTools,
  usageTools,
  keyTools,
  configTools,
  cacheTools,
} from './tools';

// === Convenience: full tenant tool table (matches raindb-cli's tenantToolTable) ===
export { tenantTools } from './tools';

// === Host adapter (v0.6+) ===
export type {
  AgentHost,
  HostFetchInit,
  HostResponse,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChoice,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionResponseMessage,
  ChatCompletionTool,
  ChatCompletionToolChoice,
  ChatContentPart,
} from './host';
export { makeNodeHost } from './host';
export { ensureHost } from './registry/ensureHost';
```

Hosts compose their own tool array. The host application keeps
its product tools in its own repo and concatenates `tenantTools`
to the end. The second consumer does the same with its own
product tools.

---

## Host adapter (v0.6+)

The package decouples its dependency on Node primitives by
funneling every outbound call through an `AgentHost`. Two known
hosts:

- **Node host** (`makeNodeHost(creds)`) -- wraps `globalThis.fetch`
  and `openai-node`. The default for both consumers' servers.
  Cheap to construct per-request.

- **Lightning bolt host** -- runs inside RainDB Lightning. Wraps
  the bolt sandbox's `ctx.fetch` + `ctx.secrets` + `ctx.log`. NOT
  shipped from this package; the bolt-side adapter lives in the
  runtime that owns the sandbox.

The contract is `src/host/types.ts`:

```typescript
interface AgentHost {
  fetch(url: string, init?: HostFetchInit): Promise<HostResponse>;
  chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  log: {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
  };
}
```

### How hosts are wired

`ToolContext.host` is a required field. Node consumers populate
it via `makeNodeHost(ctx.creds)`. Bolt consumers inject their
own. The agent loop (`runAgent`) reads `ctx.host.chatCompletion`
for every LLM round-trip; every tool reads `ctx.host.fetch` (via
`executeGraphQL` / `fetchMarketplace`) for every HTTP call.

```typescript
import { runAgent, makeNodeHost, tenantTools } from '@raindb/agent';

const creds = { apiKey: 'rdb_...', endpoint: 'http://localhost:8080/graphql' };

const result = await runAgent({
  systemPrompt: 'You are a raindb agent.',
  userPrompt: 'list my formations',
  ctx: {
    creds,
    host: makeNodeHost(creds),
    role: 'read',
  },
  tools: tenantTools,
});
```

When a `ToolContext` is constructed without a host (e.g., a host
upgrading from a pre-v0.6 version where `host` didn't exist),
internal helpers call `ensureHost(ctx)` which auto-fills
`makeNodeHost(ctx.creds)`. The TypeScript type enforces presence;
the runtime helper provides a one-time migration shim.

### Request/response shape

`ChatCompletionRequest` and `ChatCompletionResponse` mirror
OpenAI's openai-spec wire format (snake_case `tool_calls`,
`tool_call_id`, `finish_reason`). The types are package-internal
-- they're NOT a literal alias of `openai-node`'s types -- so
the package isn't coupled to openai-node version drift, and
non-OpenAI providers can be wired into a bolt host by translating
the request body internally.

### Implementing a new host

For a new runtime that isn't Node:

1. Implement `AgentHost` from scratch.
2. `fetch` returns a `HostResponse` with `.text()` and `.json()`
   methods. Both are functions (not getters) -- matches the
   bolt-sandbox-side binding shape.
3. `chatCompletion` builds the LLM provider's HTTP request body
   from the `ChatCompletionRequest`, fires it, parses the response
   into `ChatCompletionResponse`. The Lightning bolt host does
   this with `ctx.fetch` to `https://api.openai.com/v1/chat/completions`
   and an `Authorization: Bearer <key>` from `ctx.secrets.get`.
4. `log.{info,warn,error}` delegate to the runtime's logger.

`test/unit/host_adapter.test.ts` is the structural contract test:
a hand-rolled mock host drives runAgent through four scenarios
(plain chat, default-model resolution, tool-call turn, tool error)
without any global-fetch involvement. Any new host should pass
the equivalent scenarios.

---

## Conventions

These mirror the reference side and must hold across both consumers.

### Tool naming

`<domain>_<verb>` snake_case. Match the CLI subcommand path
with underscores. `pack list` -> `pack_list`. `periscope
formation describe` -> `periscope_formation_describe`. The
model relies on this convention for routing.

### Tool descriptions

Mirror the reference `Description` field exactly. Don't rewrite
for "clarity" -- the reference and TS surfaces should be
substitutable from the model's perspective. If a reference
description is wrong, fix it on the reference side first.

### Tool result shape

Each tool returns a result object directly (no wrapper). The
agent loop JSON-stringifies it for the model. This matches
the reference `ToolCallResult{Data: res}` -- the shared package
returns `res`, the agent loop wraps it. Errors throw or return
`{ error: string }` per the existing host pattern.

### `ModifiesResource: true`

Set on every mutating tool. The agent loop's confirm closure
(in `runAgent`) gates these calls. Hosts inject the confirm
function (interactive prompt for the host application; auto-yes
for `--skip-permissions` paths).

### Layer rules

The package is **leaf** -- it imports stdlib + `openai` only.
No imports from either consumer, no imports from any UI library.
If a tool needs a host-specific helper, that helper belongs in
the host repo, not here.

The agent loop accepts a `ctx` (`ToolContext`) that hosts
populate. Host-specific data goes in `ctx.product` or similar
extension field; the package treats it as opaque.

### No fallbacks

Per the wider RainDB greenfield discipline (no fallback paths):
if a tool can't reach the RainDB API, throw a clear error.
Don't return synthetic data. The agent loop surfaces the error
to the model and the model can retry or explain.

---

## What NOT to do

1. **Don't import from either consumer.** This package is
   the dependency, not the consumer. If you find yourself
   reaching into a host repo, you're putting code in the
   wrong place.

2. **Don't bake host-product context into the shared types.**
   `ToolContext` should have `creds`, `role`, optional
   `product` extension. Folders, documents, projects belong in
   the host application's tool definitions only.

3. **Don't refactor the reference side.** If you find a bug in
   the reference tool definitions, file it as a gap in the
   parity audit doc. Fix the reference side as its own commit.
   Then mirror the fix here.

4. **Don't add new tools that don't exist on the reference
   side.** The contract is parity. New tools should land in
   raindb-cli first (and in the operating manual's gap audit) so
   the surfaces stay synchronized.

5. **Don't ship without tests.** Every tool gets a unit test
   that mocks `executeGraphQL` and verifies the operation
   shape + result projection. The bulk-port phase will go
   faster if you write the test template once and copy.

6. **Don't deviate from the public API in v0.1.x.** Once
   the host application installs and consumes the package, every
   breaking change to the API costs migrations on both sides.
   Iterate on internals freely; treat the exports as contractual.

---

## Verification checklist before declaring "parity achieved"

- [ ] `@raindb/agent` builds clean (`tsc --noEmit`)
- [ ] All unit tests pass
- [ ] Every tool on the reference side has a TypeScript
      counterpart in `src/tools/<domain>.ts` with matching name
      + parameters + ModifiesResource flag
- [ ] The host application installs the package via workspace or
      registry (your call, see below)
- [ ] The host application's existing 13 tools still work
- [ ] The host application's NEW tools (the parity additions)
      work end-to-end against test-tenant via bridge dispatch
- [ ] At least 5 representative tools verified live in the
      browser (pack_list, droplet_create, formation_describe,
      sql_execute, vector_search)
- [ ] The second consumer's server consumes the package
- [ ] The second consumer's client has an agent UI that
      successfully invokes pack_list
- [ ] The parity audit doc is updated to mark gaps
      G1-G7 (or whatever the audit numbered them) as closed

---

## Distribution: how do the two consumers install this?

Two viable options. Pick one before Milestone 1:

**Option A -- Local file path (simplest, no registry).**

In each consumer's `package.json`:
```json
"dependencies": {
  "@raindb/agent": "file:../raindb-agent-ts"
}
```

Pros: no publish step, instant iteration during dev. Cons: the
sibling-directory assumption breaks if anyone clones the apps
without also cloning this repo. Has to be documented in each
app's README.

**Option B -- Private npm registry.**

Publish to a private npm registry on every tag. Each consumer's
`package.json`:
```json
"dependencies": {
  "@raindb/agent": "^0.1.0"
}
```

Plus `.npmrc` per consumer pointing at the registry. Pros: clean
dep, version pinning. Cons: setup per consumer (npm auth tokens,
.npmrc config); CI publish job to maintain.

Recommended: **Start with Option A** for Milestones 1+2 (fast
iteration, no infrastructure), **switch to Option B** for
Milestone 3 (second consumer consumption) so the apps are
independent of the local-clone assumption.

---

## Reporting back

When you finish a milestone:

1. Tag the package version (`git tag v0.1.0` etc.).
2. Push to origin.
3. Open a PR in the consumer (the host application first, the
   second consumer second) that bumps the dep + uses the new
   tools.
4. Run the verification checklist above for the milestone.
5. Update this README's status section at the top.

When all three milestones are done, the user's stated goal is
achieved: full raindb-cli parity in both consumers via a shared,
version-pinned TypeScript agent package.

---

## Why this package exists (context for future agents)

The RainDB platform agent is the canonical RainDB agent
implementation. It powers `raindb-cli ai ask`,
`raindb-cli ai chat`, and the equivalent admin verbs. ~70
tenant tools wrap every operation an operator might want to
run from a chat UI.

The host application and the second consumer are the two
TypeScript portals that also need agent surfaces. Each had (or
has) its own subset of tools, leading to drift. This package is
the de-drift solution: a single source of truth for the TS agent
runtime + tool catalog, mirroring the reference, used by both
portals.

The principle: **the reference is canonical, TS is the mirror.**
When the two diverge, the reference side wins. Future tool
additions land on the reference side first (with the operating
manual update), then mirror here.
