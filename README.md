# RainDB

> The S3 Engine for SaaS. Build a multi-tenant app, real-time AI included, in an afternoon.

RainDB collapses the SaaS stack into one substrate (S3) and one runtime (Lightning).
You write a small TypeScript bundle, declare what it touches, and ship.
Every byte you write is also the datalake. Every tenant gets RAG for free.

```
Lambda + DynamoDB + Redis + Kafka + Cognito + Pinecone + Vertex AI + Glue + Iceberg + your-multi-tenancy-code
                                            |
                                            v
                                        RainDB
```

---

## Build a SaaS app in 60 seconds

```bash
git clone github.com/gignit/joshua-vs-wopr  # the starter
cd joshua-vs-wopr/bolt
raindb-cli lightning bolt publish --profile <yours> --source . --auto-routes \
  --capabilities ./capabilities.json --deployment ./deployment.json
# https://stormfront-<hex>.<env>.raindb.gignit.com is live
```

That's the loop. Edit, re-publish, ~30s. No containers, no provisioning, no migrations.

---

## What you get out of the box

| You'd normally pay for | RainDB gives you |
|---|---|
| Database (Postgres/DynamoDB) | tenant-scoped formations on S3 -- `ctx.db.<id>.{readLatest, writeDroplet, listKeys}` |
| Cache (Redis) | object cache + wire mesh, 90% hit rate, no operator burden |
| Pub/sub (Kafka/SNS) | droplet writes -> SSE wakeups, browser-direct |
| Vector DB (Pinecone) | chunks + embeddings formations in `foundation` pack |
| LLM agent runtime (LangChain) | `@raindb/agent` -- this package, embedded in your bolt |
| Real-time push (WebSockets) | Phase 7 SSE wakeups + Phase 8 streaming responses |
| Auth (Cognito) | `ctx.iam.mintWireToken`, `ctx.jwt`, `ctx.crypto` |
| Secrets manager | `lightning-secrets` formation, `ctx.secrets.get(name)` |
| Datalake (Glue+Athena+Iceberg) | periscope cascade -- operational data IS the lake, no ETL |
| Marketplace (AWS MP) | `raindb-cli pack publish`, install across tenants |

---

## Marketplace: 12 packs install in one command

Packs are vendor-published data models + bolts. `raindb-cli pack install <name>` and the formations land on your tenant.

| Pack | What it gives you |
|---|---|
| `foundation` | Document RAG: chunks, embeddings, projects, folders, chat sessions, chat messages, coworkers, memberships. The whole AI-over-documents stack. |
| `social` | DM + group chat patterns. `pairKey` index for symmetric 1:1 lookups. See `CHAT_PATTERNS.md` in the pack for the canonical asc/desc/poll cursor pattern. |
| `tenant-base` | Per-tenant infrastructure: `lightning-secrets`, `lightning-bolts`, `lightning-bolt-stats`. Every tenant has these. |
| `lightning` | Platform-side bolt deployment formations. The dispatcher reads from these. |
| `core` | Platform-realm + env config + bridge-machinery formations. Realm-blueprint level. |
| `foundation-platform` | Users, groups, memberships, tenants, tenant keys. The control-plane data model. |
| `platform-runtime` | Genesis provisioner config, AWS environment binding. Realm-genesis-level wiring. |
| `platform-services` | Cyclone/scheduler/wire/cache shared service formations. |
| `media-photos` | Photo + album with binary float support. Reference for binary-asset float pipeline. |
| `finance-transactions` | Ledger pattern: append-only transactions, balance derivation. |
| `real-estate-listings` | MLS-shaped: property listings + property images. |
| `user-auth-email` | Email/password identity + verification flow. |
| `guide-patterns` | The canonical RainDB design patterns doc -- read this BEFORE designing your own formation. |

Browse: `~/src/raindb-base/vendors/raindb/packs/<pack>/` -- each has `pack.json`, `formations/`, often a `README.md` and `*PATTERNS.md`.

---

## Reference apps to copy from

| Repo | Demonstrates | Read it when |
|---|---|---|
| `github.com/gignit/joshua-vs-wopr` | Minimal LLM bolt: tic-tac-toe + chat, ~700 lines of plain JS, SSE streaming responses, Phase 7 wakeups. | You're new. Read this first. |
| `github.com/gignit/super-calculator` | Streaming agent UI patterns + multi-tool LLM loop. | You're building an AI-augmented productivity bolt. |
| `github.com/gignit/fdn-app` | Production RAG: documents, multi-project, multi-user, agent + tool calls, full SPA. | You're building a Foundation-pack-shaped knowledge product. |

---

## What an agent (human or AI) needs to know

Read in order. Each pointer is one file.

1. **Mental model**: `~/src/raindb-base/vendors/raindb/packs/guide-patterns/` -- formations, droplets, indexes, listKeys + UUIDv7. The substrate.
2. **Build a bolt**: `raindb-phoenix-lightning/docs/RAINDB_LIGHTNING_TENANT_GUIDE.md` -- the TypeScript developer manual. ~21k words; read by section.
3. **Engine internals (when you need to extend Lightning itself)**: `raindb-phoenix-lightning/docs/RAINDB_LIGHTNING_PLATFORM_GUIDE.md`.
4. **Find a pack**: `ls ~/src/raindb-base/vendors/raindb/packs/`, then `cat <pack>/pack.json` + `ls <pack>/formations/`.
5. **Find a pattern**: `<pack>/README.md` + `<pack>/*PATTERNS.md` + `<pack>/TROUBLESHOOTING.md` if it exists.
6. **Find an example bolt**: clone one of the three reference repos.

That's it. Six files, six pointers.

---

## Anatomy of a bolt

```
bolt/
  capabilities.json   # what the bolt can touch (formations, secrets, network, limits)
  routes.json         # how requests reach handlers (block / static / sse / dynamic)
  deployment.json     # mount + healthcheck hints
  server/index.ts     # exports onHttpRequest(ctx, req) -> Response | streams
  client/             # optional SPA assets
  formations/         # optional bolt-bundled formation configs + schemas
```

```typescript
// server/index.ts
exports.onHttpRequest = async (ctx, req) => {
  if (req.path === '/api/messages' && req.method === 'POST') {
    const msg = JSON.parse(req.body);
    msg.messageId = ctx.ids.uuidv7();
    await ctx.db['fdn-chat-messages'].writeDroplet(msg);
    return { status: 200, headers: {}, body: JSON.stringify({ ok: true }) };
  }
  return { status: 404, headers: {}, body: 'not found' };
};
```

Tenant-scoped, sandboxed (goja JS runtime), invocation-isolated. The `ctx` object is the entire environment -- no `process`, no `fs`, no surprises.

---

## The @raindb/agent package (this repo)

A TypeScript LLM agent runtime + tool catalog. Embed in your bolt's handler when you want the bolt to talk to a model with tool-calling.

```typescript
import { runAgent } from '@raindb/agent';

await runAgent({
  ctx, req, openaiApiKey: ctx.secrets.get('openai_api_key'),
  tools: [/* RegisteredTool[] */],
  onEvent: (e) => ctx.response?.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`),
});
```

`fdn-app/bolt/server/routes/chat.ts` is the canonical worked example. Streams agent thinking + tool calls + final reply chunk-by-chunk via Phase 8 streaming responses.

---

## Where to ask questions

- The pack README + PATTERNS + TROUBLESHOOTING docs are usually the answer.
- The reference bolts (`joshua-vs-wopr`, `super-calculator`, `fdn-app`) are the second answer.
- The two lightning guides cover everything else.

Six pointers. One substrate. Ship.
