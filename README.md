# @raindb/agent

A TypeScript LLM agent loop + tool catalog. Embed in your bolt's
handler when you want the bolt to talk to a model with tool-calling.

This is a sister package to [`@raindb/bolt-sdk`](../raindb-bolt-sdk-ts/README.md).
The bolt-sdk gives you the runtime bindings (database, secrets, IAM,
streaming response, etc.). This package gives you the LLM agent loop
that drives multi-turn conversations with tool calls, and a rich tool
catalog over RainDB's data primitives.

The two compose: in a bolt, you import `runAgent` from this package,
build an `AgentHost` via `makeBoltNativeHost(ctx)` from the bolt-sdk,
and stream `AgentEvent`s out as SSE frames using `ctx.response.write`.

---

## Table of contents

1. [What this package is](#what-this-package-is)
2. [Quick start in a bolt](#quick-start-in-a-bolt)
3. [Quick start as a Node CLI / library](#quick-start-as-a-node-cli--library)
4. [The agent loop: how it works](#the-agent-loop-how-it-works)
5. [`AgentEvent` -- streaming the loop's progress](#agentevent--streaming-the-loops-progress)
6. [Tools: catalog + authoring](#tools-catalog--authoring)
7. [Hosts: bolt-native vs Node](#hosts-bolt-native-vs-node)
8. [Model resolution + LLM provider integration](#model-resolution--llm-provider-integration)
9. [The agent loop + SSE streaming pattern](#the-agent-loop--sse-streaming-pattern)
10. [Identity, roles, and authorization](#identity-roles-and-authorization)
11. [Working with RAG (chunks + embeddings)](#working-with-rag-chunks--embeddings)
12. [Compatibility + versioning](#compatibility--versioning)
13. [See also](#see-also)

---

## What this package is

`@raindb/agent` is a thin agent loop layered over the openai-spec
chat-completions API. It:

- Sends a system prompt + history + user prompt to the model.
- Detects tool calls in the response.
- Filters the available tool catalog by the caller's role
  (`'read'` / `'write'` / `'admin'`).
- Executes each tool call against an injected `ToolContext`.
- Feeds tool results back into the next turn.
- Emits an `AgentEvent` for every phase (`thinking`, `tool-call`,
  `tool-result`, `tool-error`, `final`) so the caller can stream
  progress in real time.
- Returns when the model emits a tool-less response or the iteration
  cap fires.

The package is **transport-agnostic**: it accepts an `AgentHost`
abstraction with two methods (`fetch` + `chatCompletion`). The same
package works inside a bolt (host wraps `ctx.fetch` and routes
substrate calls through native bindings) and on Node (host wraps
global `fetch` and openai-node).

The package is **opinionated about the agent loop, not the model**.
You can use OpenAI directly, the RainDB API's `/v1/chat/completions`
proxy (which routes through the configured LLM provider), or any
OpenAI-spec-compatible endpoint.

---

## Quick start in a bolt

```typescript
import { setCtx, BoltContext, BoltRequest, BoltResponse } from '@raindb/bolt-sdk';
import { makeBoltNativeHost } from '@raindb/bolt-sdk/agent-bridge';
import { runAgent, tenantTools } from '@raindb/agent';

export async function onHttpRequest(
  ctx: BoltContext,
  req: BoltRequest,
): Promise<BoltResponse> {
  setCtx(ctx);

  if (req.method !== 'POST' || req.path !== '/api/chat') {
    return { status: 404, body: 'not found' };
  }

  const body = req.json as { message: string; history?: unknown[] };

  const result = await runAgent({
    systemPrompt: 'You are a helpful assistant for this project.',
    userPrompt:   body.message,
    history:      (body.history ?? []) as never,
    ctx: {
      creds: {
        apiKey:   await ctx.secrets.get('platform-api-key'),
        endpoint: await ctx.secrets.get('platform-api-endpoint'),
      },
      host:   makeBoltNativeHost(ctx),
      role:   'read',
      userId: ctx.auth?.subject ?? 'anonymous',
    },
    tools: tenantTools,
  });

  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content:    result.content,
      iterations: result.iterations,
      durationMs: result.durationMs,
    }),
  };
}
```

The agent loop resolves the chat model automatically via RainDB's
`llmRegistry` (cached 5min per API key). Override with `model:
'gpt-5'` to pin a specific model.

To stream progress to the browser as the loop runs, declare the route
as `streaming: true` in `routes.json` and forward each `AgentEvent`
as an SSE frame -- see [the SSE pattern](#the-agent-loop--sse-streaming-pattern)
below.

---

## Quick start as a Node CLI / library

The package works equally well outside a bolt. Useful when you're
building an agentic CLI that talks to a remote RainDB realm:

```typescript
import { runAgent, tenantTools, makeNodeHost } from '@raindb/agent';

const result = await runAgent({
  systemPrompt: 'You are a helpful tenant administrator.',
  userPrompt:   'How many droplets are in the lightning-bolts formation?',
  ctx: {
    creds: {
      apiKey:   process.env.RAINDB_API_KEY!,
      endpoint: process.env.RAINDB_API_ENDPOINT!,
    },
    host:   makeNodeHost(),  // wraps global fetch + openai-node
    role:   'admin',
    userId: 'cli-user',
  },
  tools:   tenantTools,
  onEvent: (e) => console.log(e.type, JSON.stringify(e)),
});

console.log('FINAL:', result.content);
console.log('iterations:', result.iterations, 'toolCalls:', result.toolCallsTotal);
```

---

## The agent loop: how it works

```
                      runAgent({ systemPrompt, userPrompt, ctx, tools, ... })
                                            |
                                            v
        +-----------------------------------+-----------------------------------+
        | 1. Compose messages: [system, ...history, user]                       |
        | 2. Resolve chat model (cached per apiKey 5min)                        |
        | 3. Filter tools by ctx.role                                           |
        +-----------------------------------+-----------------------------------+
                                            |
            +---------------------------------------------------------------+
            |  LOOP (up to maxIterations, default 12 hard cap)             |
            |                                                              |
            |  +-- emit 'thinking' { iteration }                          |
            |  |                                                          |
            |  +-- host.chatCompletion({ model, temperature, messages,   |
            |  |     tools })                                            |
            |  |                                                          |
            |  +-- if no tool_calls in response:                          |
            |  |       emit 'final' { content, iterations, ... }          |
            |  |       return AgentResult                                 |
            |  |                                                          |
            |  +-- for each tool_call:                                    |
            |  |       emit 'tool-call' { iteration, toolName, args }    |
            |  |       if tool.modifiesResource and opts.confirm:        |
            |  |         await confirm({ toolName, args, ctx }) or skip  |
            |  |       try execute(ctx, args)                            |
            |  |       emit 'tool-result' or 'tool-error'                 |
            |  |       append tool message to history                     |
            |  |                                                          |
            |  +-- next iteration                                         |
            +---------------------------------------------------------------+
                                            |
                                            v
                AgentResult { content, iterations, toolCallsTotal,
                              durationMs, history, toolEvents }
```

Key invariants:

- **One model per turn.** Switching models mid-loop would make the
  history incoherent. `opts.model` is resolved once at turn start.
- **Tool calls are openai-spec.** The package translates between the
  openai-spec `tool_calls` array and your `RegisteredTool.execute`
  functions. Tool-result rows are appended with `tool_call_id` so the
  next turn's response correctly references them.
- **Errors are tool results, not exceptions.** A tool that throws OR
  returns `{ error: '...' }` becomes a `'tool-error'` event AND a
  tool-message in the history. The model can see the error and
  potentially retry with different arguments.
- **The loop is bounded.** `maxIterations` defaults to a safe value
  and is hard-capped (currently 12). If the model is still calling
  tools at the cap, the loop emits a `'final'` event with a fallback
  message and returns.

---

## `AgentEvent` -- streaming the loop's progress

Hosts subscribe via `runAgent({ onEvent })`. Each event corresponds
to one phase in the loop:

```typescript
export type AgentEvent =
  | { type: 'thinking'; iteration: number }
  | { type: 'tool-call';   iteration: number; toolName: string; args: ToolArgs }
  | { type: 'tool-result'; iteration: number; toolName: string;
      durationMs: number; ok: boolean; preview?: string; result?: unknown }
  | { type: 'tool-error';  iteration: number; toolName: string; error: string }
  | { type: 'final';       content: string; iterations: number;
      toolCalls: number; durationMs: number };
```

Translate each event to your transport:

- **In a bolt with `streaming: true`**: forward each event as an SSE
  frame. Browser sees per-event progress (typing indicator on
  `thinking`, tool announcements on `tool-call`, tool errors live,
  final reply as it streams).
- **In a CLI**: print one log line per event with the iteration +
  tool name. Useful for debugging long agent runs.
- **In a UI**: route to a state machine that shows "thinking" /
  "running tool X" / "error: ..." / final markdown render.

---

## Tools: catalog + authoring

### Pre-built tool catalogs

| Export | What's in it | When to use |
|---|---|---|
| `tenantTools` | The full RainDB tenant-side tool surface: droplet CRUD, catalog ops, entity ops, SQL + vector search, formation introspection, cache, periscope, key ops, config, usage, relay, digest pipeline, LLM registry, marketplace, chains, index pages. | Agent should be able to do "anything a tenant admin can do via raindb-cli." |
| `dropletTools` | `droplet_list`, `droplet_read`, `droplet_write`, `droplet_expire`. | Agent only needs to manipulate droplets. |
| `queryTools` | `sql_execute`, `vector_search`. | Agent is doing analytics or RAG. |
| `digestTools` | `digest_list`, `digest_show`. | Agent answers questions about ingestion / pipeline status. |
| `llmTools` | `llm_provider_list`, `llm_model_list`, `llm_usage_report_summary`. | Agent is helping the user understand their LLM cost / setup. |
| `marketplaceTools` | Pack browse / install. | Agent helps user discover and install raindb packs. |
| (others: `catalogTools`, `entityTools`, `formationTools`, `cacheTools`, `periscopeTools`, `keyTools`, `configTools`, `usageTools`, `relayTools`, `chainTools`, `indexPageTools`) | One narrow domain each. | Compose your own list when you want a focused subset. |

### Custom tools

```typescript
import { RegisteredTool, ToolFn } from '@raindb/agent';

const execute: ToolFn = async (ctx, args) => {
  const projectId = String(args.projectId ?? '');
  if (!projectId) return { error: 'projectId required' };

  // ctx.host gives you fetch + chatCompletion
  // ctx.creds gives you apiKey + endpoint for substrate calls
  // ctx.userId gives you the authenticated end-user (for audit)
  // ctx.role gives you 'read' | 'write' | 'admin'

  const res = await ctx.host.fetch(`${ctx.creds.endpoint}/api/projects/${projectId}/stats`, {
    method:  'GET',
    headers: { 'authorization': `Bearer ${ctx.creds.apiKey}` },
  });
  if (!res.ok) return { error: `stats lookup failed: HTTP ${res.status}` };
  return await res.json();
};

export const project_stats: RegisteredTool = {
  name:        'project_stats',
  description: 'Get usage statistics for a project. Returns total droplets, embeddings, tokens consumed. Equivalent CLI: raindb-cli project stats <projectId>.',
  minRole:     'read',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project UUID (payload.projectId, not droplet ID).',
      },
    },
    required: ['projectId'],
  },
  execute,
};

// Then add to the catalog you pass to runAgent:
await runAgent({
  systemPrompt: '...',
  userPrompt:   '...',
  ctx:          { ... },
  tools:        [...tenantTools, project_stats],
});
```

### Tool authoring rules

| Rule | Why |
|---|---|
| Name in `snake_case`, matches CLI verb path (`raindb-cli pack list` -> `pack_list`) | The model relies on this convention for routing |
| Description states result type + inputs + equivalent CLI verb | Saves tokens and helps the model pick the right tool |
| `minRole` set to lowest privilege that can call the tool | The agent loop filters the catalog by `ctx.role` BEFORE sending to the model -- tools above the caller's grant aren't even shown |
| `modifiesResource: true` on every write tool | The agent loop's `confirm` callback gates these calls -- hosts can interpose an interactive prompt OR auto-yes |
| Return a JSON-serializable object | Loop stringifies the result; the model sees it as a `tool` message |
| Errors return `{ error: '...' }` OR throw | Either becomes a `'tool-error'` event AND a tool message; the model can retry |
| `execute` is async; await every I/O | The loop awaits each tool sequentially within an iteration |
| Validate args at the top of `execute` | Bad args from the model are normal; return `{ error: 'argName required' }` so the model retries |

### How role filtering works

The agent loop calls `buildToolDefs(catalog, ctx.role, defaultRoleAllows)`
to produce the openai-spec `tools` array sent to the model. The
default allow-map:

| Caller role | Sees tools where `minRole` is... |
|---|---|
| `'read'`   | `'read'` only |
| `'write'`  | `'read'` OR `'write'` |
| `'admin'`  | `'read'` OR `'write'` OR `'admin'` |

If `ctx.role === 'read'`, the model literally never sees the `droplet_write`
tool, can't ask to call it, can't fall through to a "the model
chose admin power" failure mode. The substrate STILL enforces the
grant on every call -- defense in depth.

---

## Hosts: bolt-native vs Node

The package factors transport through the `AgentHost` interface:

```typescript
export interface AgentHost {
  fetch(url: string, init?: HostFetchInit): Promise<HostResponse>;
  chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  log: { info; warn; error };
}
```

### `makeBoltNativeHost(ctx)` -- in a bolt

```typescript
import { makeBoltNativeHost } from '@raindb/bolt-sdk/agent-bridge';
import { runAgent, tenantTools } from '@raindb/agent';

const host = makeBoltNativeHost(ctx);
await runAgent({ ..., ctx: { ..., host } });
```

This host:

- Routes **substrate-shaped GraphQL** calls (droplet_*, vector_search,
  catalog_*, etc.) through the bolt's native bindings -- no HTTP
  self-loop back through the gateway.
- Routes **LLM provider calls** (`chatCompletion`) through `ctx.fetch`
  -- those are genuinely external HTTP. The request shape mirrors
  OpenAI's `ChatCompletion` envelope.
- Routes **non-GraphQL URLs** (e.g. third-party APIs your custom
  tools call) through `ctx.fetch` directly.
- Translates `ctx.log` so the agent loop's structured logs land in
  the bolt's log stream with the bolt's requestId attached.

### `makeNodeHost()` -- outside a bolt

```typescript
import { makeNodeHost } from '@raindb/agent';

const host = makeNodeHost();
await runAgent({ ..., ctx: { ..., host } });
```

This host:

- Routes **every** call (GraphQL + LLM provider + arbitrary URLs)
  through `globalThis.fetch`. The Node implementation MUST be Node
  18+ (fetch is built in).
- Wraps the openai-node client for `chatCompletion` so streaming and
  token-counting work without re-implementing the openai wire
  protocol.

### Custom host (for tests / alternate transports)

```typescript
const fakeHost: AgentHost = {
  async fetch(url, init) {
    return { ok: true, status: 200, text: async () => '...', json: async () => ({...}) };
  },
  async chatCompletion(req) {
    return { id: 't', choices: [{ message: { role: 'assistant', content: 'mocked' } }] };
  },
  log: { info: () => {}, warn: () => {}, error: () => {} },
};

await runAgent({ ..., ctx: { ..., host: fakeHost } });
```

The unit tests in this package use exactly this pattern.

---

## Model resolution + LLM provider integration

The package never picks a model out of thin air. Two ways a model
gets chosen:

1. **Caller pins it**: `runAgent({ model: 'gpt-5' })`. Wins.
2. **Caller leaves it unset**: the loop calls
   `resolveDefaultChatModel(ctx.creds, ctx.host)` which queries
   RainDB's `llmRegistry` GraphQL endpoint and returns the model id
   the platform has registered as the `'chat'` default. Cached per
   `creds.apiKey` for 5 minutes (hot path = one round trip per cache
   TTL). If the registry has no model with chat capability,
   `resolveDefaultChatModel` throws -- the caller surfaces the error
   to the user. No fallback to invent a model.

To register or change the platform's default chat model, use
raindb-cli:

```bash
raindb-cli --profile raindb.<env> llm-model add --provider openai \
  --model gpt-5 --capabilities chat,embedding
raindb-cli --profile raindb.<env> llm-config set-default \
  --capability chat --model gpt-5
```

Other resolvable capabilities the platform commonly registers:
`'chat'`, `'embedding'`, `'image'`, `'vision'`, `'code-interpreter'`.

### Where the actual LLM call goes

The `chatCompletion` host method routes the request. In a bolt with
`makeBoltNativeHost`, the request goes:

```
your handler
   |
   v
runAgent
   |
   v
host.chatCompletion(req)
   |
   v
ctx.fetch( <restBase>/v1/chat/completions , req )
   |
   v
the RainDB API's /v1/chat/completions endpoint
   |
   v
configured LLM provider (OpenAI, Anthropic, Bedrock, ...)
```

`restBase` is derived from `ctx.creds.endpoint` (typically
`https://api.raindb.io`). The RainDB API is the openai-spec
proxy that fronts the configured LLM provider -- this means your bolt
DOES NOT need an OpenAI API key. The bolt holds a RainDB API key
(scoped to the bolt's tenant) and the RainDB API transparently forwards
to whichever LLM provider the realm has configured.

The platform's idle timeout MUST be long enough for the worst-case
LLM round-trip. RainDB ships a 300s idle timeout to cover
RAG-augmented chats. If you see 504s at exactly 60s on a deployed
env, contact your platform operator.

---

## The agent loop + SSE streaming pattern

Routes declared `streaming: true` in `routes.json` get the streaming
dispatch path (see [`@raindb/bolt-sdk`'s SSE section](../raindb-bolt-sdk-ts/README.md#sse-streaming-responses)).
Forward each `AgentEvent` as an SSE frame:

```typescript
import { setCtx, response, BoltContext, BoltRequest, BoltResponse } from '@raindb/bolt-sdk';
import { makeBoltNativeHost } from '@raindb/bolt-sdk/agent-bridge';
import { runAgent, tenantTools, type AgentEvent } from '@raindb/agent';

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function onHttpRequest(
  ctx: BoltContext,
  req: BoltRequest,
): Promise<BoltResponse> {
  setCtx(ctx);

  if (req.method !== 'POST' || req.path !== '/api/chat') {
    return { status: 404, body: 'not found' };
  }

  // ctx.response is only wired when the route declared streaming: true.
  // Bolts that share one handler across streaming + non-streaming routes
  // branch here. The 'frames' array captures the buffered fallback.
  const streaming = ctx.response !== undefined;
  const frames: string[] = [];

  if (streaming) {
    await response.setHeader('content-type', 'text/event-stream');
    await response.setHeader('cache-control', 'no-cache, no-transform');
    await response.setHeader('connection', 'keep-alive');
    await response.beginStream(200);
  }

  const send = (frame: string): void => {
    if (streaming) {
      void response.write(frame);
    } else {
      frames.push(frame);
    }
  };

  const body = req.json as { message: string; history?: unknown[] };

  try {
    const result = await runAgent({
      systemPrompt: 'You are a helpful assistant.',
      userPrompt:   body.message,
      history:      (body.history ?? []) as never,
      ctx: {
        creds: {
          apiKey:   await ctx.secrets.get('platform-api-key'),
          endpoint: await ctx.secrets.get('platform-api-endpoint'),
        },
        host:   makeBoltNativeHost(ctx),
        role:   'read',
        userId: ctx.auth?.subject ?? 'anonymous',
      },
      tools:   tenantTools,
      onEvent: (e: AgentEvent) => send(sseFrame(e.type, e)),
    });

    send(sseFrame('done', {
      iterations:     result.iterations,
      toolCallsTotal: result.toolCallsTotal,
      durationMs:     result.durationMs,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    send(sseFrame('error', { error: msg }));
  }

  if (streaming) {
    return { status: 200, headers: {}, body: '' };
  }
  return {
    status: 200,
    headers: {
      'content-type':  'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection':    'keep-alive',
    },
    body: frames.join(''),
  };
}
```

What the browser sees on a streaming route:

```
event: thinking
data: {"type":"thinking","iteration":1}

event: tool-call
data: {"type":"tool-call","iteration":1,"toolName":"vector_search","args":{...}}

event: tool-result
data: {"type":"tool-result","iteration":1,"toolName":"vector_search","durationMs":482,"ok":true,"preview":"{\"hits\":[...]}..."}

event: thinking
data: {"type":"thinking","iteration":2}

event: final
data: {"type":"final","content":"Based on the search results, ...","iterations":2,"toolCalls":1,"durationMs":3489}

event: done
data: {"iterations":2,"toolCallsTotal":1,"durationMs":3489}
```

Each event arrives as a separate network packet. Browser receives
the typing indicator instantly, sees each tool announcement as it
happens, and renders the final reply progressively.

Your bolt's chat route handler is the canonical place for this
pattern: RAG context, a multi-tool agent loop, and full SSE
streaming together cover the entire production pattern.

---

## Identity, roles, and authorization

The agent loop trusts the caller to populate `ctx.role` correctly.
The CALLER is responsible for resolving the end-user's effective role
before invoking `runAgent`.

### In a bolt

```typescript
import { auth } from '@raindb/bolt-sdk';

const callerRole: 'read' | 'write' | 'admin' = (() => {
  if (auth.isAnonymous) return 'read';
  // Bolt-specific logic: look up the user's role from your own
  // tenancy model (e.g. your app's project-membership table)
  const role = lookupUserRoleForProject(auth.subject, projectId);
  return role;
})();

await runAgent({
  ...,
  ctx: {
    creds: { apiKey, endpoint },
    host: makeBoltNativeHost(ctx),
    role: callerRole,
    userId: auth.subject,
  },
  tools: tenantTools,
});
```

**Crucially**: `ctx.role` is INPUT to the agent's tool filtering.
The substrate STILL enforces the grant on every actual droplet call
-- so if a `'read'` user somehow ends up with the `droplet_write`
tool exposed, the substrate rejects the write. But the cleanest
defense-in-depth posture is to filter the catalog BEFORE the model
sees it.

### Cross-checking via `ctx.auth.permits`

For ESPECIALLY sensitive operations, pre-check the grant before even
including a tool in the catalog:

```typescript
const tools = [...readOnlyToolset];
if (ctx.auth?.permits('formation', 'private-notes', 'write')) {
  tools.push(write_private_note);
}
await runAgent({ ..., tools });
```

### Custom tools that gate on userId

Every tool's `execute` function has access to `ctx.userId`. Custom
tools that touch user-private data MUST filter on `ctx.userId`, not
on an args field the model could spoof:

```typescript
const list_my_notes: RegisteredTool = {
  name:        'list_my_notes',
  description: 'List notes belonging to the authenticated user.',
  minRole:     'read',
  parameters:  { type: 'object', properties: {}, required: [] },
  async execute(ctx, _args) {
    // CORRECT: trust ctx.userId (resolved at handler boundary)
    return await listNotesForUser(ctx.userId, ctx.creds, ctx.host);
  },
};
```

Never write a tool that takes a `userId` arg from the model and
trusts it. The model will happily pass any userId the user asks it
to.

---

## Working with RAG (chunks + embeddings)

The `vector_search` tool (in `queryTools` and re-exported in
`tenantTools`) is the canonical RAG entry point. Combined with
custom tools that walk the chunk + document hierarchy, you get a
complete RAG agent:

```typescript
import { runAgent, tenantTools, vector_search } from '@raindb/agent';

await runAgent({
  systemPrompt: `You are an assistant for this project's documents.
When the user asks about document content:
  1. Use vector_search with formationId='${projectMeta.embeddingsFormation}'
     and model='${projectMeta.embeddingModel}' to find relevant chunks.
  2. If you need more context around a hit, use get_chunk_range to
     pull the surrounding chunks.
  3. Cite the document name + chunk index in your response.`,
  userPrompt:   body.message,
  ctx: { ... },
  tools: [
    vector_search,
    get_chunk_range,        // custom tool
    resolve_document_path,
    get_document_text,
  ],
});
```

A RAG bolt defines its own canonical formations
(e.g. `documents`, `chunks`, `embeddings`) driving the
production-grade RAG implementation.

---

## Compatibility + versioning

| `@raindb/agent` | `@raindb/bolt-sdk` (in-bolt) | RainDB API version |
|---|---|---|
| 0.7.x | 0.1.x | 1.0.x |
| 0.8.x (current) | 0.4.x | 1.0.x + mintScopedGrant + ctx.auth |
| 1.0.x (target) | 1.0.x | 1.5.x |

The Node path (`makeNodeHost`) is self-contained and tracks the
openai-node major it ships with.

---

## See also

- [`@raindb/bolt-sdk`](../raindb-bolt-sdk-ts/README.md) -- the bolt
  runtime bindings. Read it first if you're writing bolts; the SSE
  + IAM patterns + marketplace pack inventory are documented there.
- The RainDB marketplace -- browse it to understand how packs are
  published, installed, or version-bumped.
- The canonical RainDB design-patterns guide (published as a
  marketplace pack). Read first when designing a new formation that
  an agent tool will read or write.
- The RAG pack guide (published as a marketplace pack). This is the
  production RAG pack -- `documents`, `chunks`, `embeddings`, plus
  projects / folders / chat sessions / chat messages / coworkers /
  memberships. Install + read this when your agent does RAG over
  user-uploaded documents.
- The chat-patterns guide (published as a marketplace pack) --
  canonical chat pattern: AI-agent participants, SSE-streamed LLM
  responses, asc/desc/poll cursor pattern with tuple-match dedup.
- A production RAG application built on RainDB -- documents,
  multi-project, multi-user, agent + tool calls, full SPA -- is the
  reference for the complete end-to-end pattern.

---

## License

Internal (private package). Public license TBD when the package goes
public.
