# Building on RainDB

**The public guide for humans and AI agents building applications
on RainDB.** Short, copy-pasteable, no assumed knowledge.

---

## What RainDB is

RainDB is the platform that does what a traditional server normally
takes care of: storage, identity, sessions, indexes, queries, cross-
tenant bridges, cache, cascade pipelines, and compute (Lightning
Bolts). You don't build "a backend backed by RainDB" -- you build a
**client** plus a **thin compute layer (a Bolt)** that translates
HTTP requests into RainDB operations. The Bolt is the smallest thing
that turns `GET /api/things` into `readLatest("things", ...)` and
returns the result as JSON.

The Bolt runs inside RainDB's Lightning runtime (a goja JavaScript
sandbox running on the platform's ALB-fronted dispatcher). Once
deployed, your Bolt:

- **Has a public URL** at `https://stormfront-<hex>.<env>.raindb.gignit.com`
  (and optionally a custom domain you specify at publish time).
- **Has secrets** declared in `capabilities.json` and pre-staged
  in the `lightning-secrets` formation -- accessible at runtime via
  `ctx.secrets.get("name")`.
- **Has formation access** declared in `capabilities.json` -- read
  and write to specific RainDB formations.
- **Has signed-grant access** to raindb-api via the cross-admin grant
  the Bolt's tenant carries.

A traditional Node/Express server is OPTIONAL. Most apps will not
need one. Apps that DO need long-running background work (queue
consumers, schedulers) can run a separate process and write to
RainDB formations the Bolt reads from -- but the HTTP request/
response surface lives in the Bolt.

---

## First read: the Marketplace

**Before you write code, browse the Marketplace.** The Marketplace
is a catalog of pre-built RainDB packs covering common patterns:
identity (`auth-email`), tenant-base formations, the Foundation
data model (projects, folders, documents, agents), platform
patterns, lightning runtime helpers, etc. Each pack ships with
a `README.md`, ready-to-publish formation configs, schemas, and
prose explaining when to use it.

If you're about to build an auth layer, a tenant registry, or a
document store -- **stop and check if a pack already solves it**.
The Marketplace IS your seed information. Agents that skip the
Marketplace reinvent what's already there.

Browse via the dashboard's Marketplace tab on any RainDB
environment, OR via the REST surface:

```bash
curl -H "X-API-Key: $RAINDB_API_KEY" \
  https://api.<env>.raindb.gignit.com/api/marketplace/packs
```

---

## Quickstart: from zero to live Bolt in ~5 minutes

This walks through the minimum path: tenant + secrets + Bolt source +
publish. Adapt for your own app name/domain.

### 1. Get a tenant + API key

A RainDB tenant gives you a namespace and credentials. Create one
via the dashboard UI on your target environment (recommended) or
via the CLI:

```bash
# Dashboard flow (recommended):
#   1. Visit https://<env>.raindb.gignit.com
#   2. Register an account (or log in)
#   3. Create a Group from the home page
#   4. Create a Tenant from the Group page; pick a realm
#   5. Copy the API key shown in the "Tenant created" modal
#      (this is your rgr1.* admin key -- you'll only see it once)

# CLI flow (for infra automation):
ssh raindb-<env>   # the env's instance
~/raindb/bin/raindb-admin --profile raindb.<env> tenant create \
  --realm <realm-id> --name my-app
# The output includes the rgr1.* admin key. Save it.
```

The CLI flow on a fresh local env also auto-saves a profile named
`core.<env>.<tenant-name>` that you'll use for subsequent
`raindb-cli` commands.

### 2. Scaffold a Bolt

Copy the structure from a working reference (raindb-app's bolt
is canonical; fdn-app's bolt is also fine):

```
my-app/
  bolt/
    capabilities.json           # which formations + secrets you need
    deployment.json             # mount config + ALB hints
    routes.json                 # dispatch table (or use --auto-routes)
    package.json                # one dep: @raindb/agent (if you use it)
    bin/build-bolt.sh           # vite build + raindb-cli publish
    server/
      types.ts                  # BoltCtx / BoltReq / BoltResp
      http.ts                   # ok / bad / unauthorized helpers
      auth.ts                   # JWT verify + session lookup
      raindb.ts                 # GraphQL client (sync, ctx.fetch)
      index.ts                  # onHttpRequest dispatcher
      routes/
        myFeature.ts            # one file per route domain
  client/                       # vite + react / svelte / whatever
```

Minimum `bolt/server/index.ts`:

```typescript
import type { BoltCtx, BoltReq, BoltResp } from "./types";

export async function onHttpRequest(ctx: BoltCtx, req: BoltReq): Promise<BoltResp> {
  if (req.method === "GET" && req.path === "/api/health") {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { status: "ok", service: "my-app" },
    };
  }
  return { status: 404, body: { error: "not found" } };
}
```

Minimum `bolt/capabilities.json`:

```json
{
  "raindb": {
    "formations": [],
    "secrets": { "names": [] }
  },
  "network": { "egress": ["raindb.gignit.com"] },
  "limits": { "memMb": 128 }
}
```

Minimum `bolt/deployment.json`:

```json
{
  "preferredMount": "/",
  "healthcheckPath": "/api/health"
}
```

### 3. Stage secrets (if your Bolt needs any)

Bolts can't read environment variables. Every secret is an explicit
named droplet in the `lightning-secrets` formation on the tenant
the Bolt runs on. Stage them BEFORE publishing:

```bash
cat > /tmp/secrets.json <<JSON
[
  {"name": "my_app_api_key", "value": "rgr1.eyJ2IjoxLC..."},
  {"name": "my_app_jwt_secret", "value": "shared-with-callers"}
]
JSON

raindb-cli --profile core.<env>.my-app droplet create \
  --formation lightning-secrets --file /tmp/secrets.json
```

The names you stage MUST match the names in `capabilities.json`'s
`raindb.secrets.names` array. The runtime refuses to read secrets
that aren't declared.

### 4. Publish

```bash
raindb-cli --profile core.<env>.my-app lightning bolt publish \
  --source ./bolt --name my-app --auto-routes \
  --capabilities ./bolt/capabilities.json \
  --deployment ./bolt/deployment.json
```

Output includes:
- `BoltID` -- stable across republishes; reuse via `--name`
- `BoltStatsID` -- scope value for the bolt's stats droplet; carried forward
- `Revision` -- the immutable revision droplet ID for this publish
- `Mode` -- `fresh publish` (new bolt) or `republish (server-side merge with prior droplet)`
- `AutogenURL` -- the autogen `stormfront-<hex>.<env>.raindb.gignit.com`

Wait ~10-30 seconds for genesis to provision the ALB listener rule,
then:

```bash
curl https://stormfront-<your-hex>.<env>.raindb.gignit.com/api/health
# -> {"status":"ok","service":"my-app"}
```

**Single round trip + server-side merge.** As of FD-65 (see
`raindb-phoenix-lightning/docs/RAINDB_PHX_LIGHTNING.md`), publish
is a single `publishBolt` GraphQL mutation. The CLI sends the
bolt manifest as one opaque JSON payload; the server resolves
identity (name -> boltId via the `by-name-latest` pointer index),
merges with the prior bolt droplet (so fields the operator
didn't change are carried forward), ensures the
lightning-bolt-stats token droplet exists, and writes one new
immutable revision. You don't need to track the BoltID manually
-- republishing by name reuses everything.

### 5. Iterate

Edit a route handler. Rebuild + republish:

```bash
raindb-cli --profile core.<env>.my-app lightning bolt publish \
  --source ./bolt --name my-app --auto-routes \
  --capabilities ./bolt/capabilities.json \
  --deployment ./bolt/deployment.json
# Mode: republish (server-side merge with prior droplet)
# Reuses BoltID + BoltStatsID by name match -- same URL, new revision.
# ~5-15 seconds per cycle.
```

The server-side merge means you can omit flags you don't need to
change. If you're only iterating on the bundle (e.g. fixing a
handler), the routes/capabilities/deployment/domain all carry
forward from the prior droplet automatically.

Wrap that in a 10-line `fswatch` watcher script if you want
auto-publish on file change. Example:

```bash
#!/usr/bin/env bash
# bolt/bin/watch.sh -- republish on TS change
fswatch -o ./server | while read; do
  raindb-cli --profile core.dev.my-app lightning bolt publish \
    --source ./bolt --name my-app --auto-routes \
    --capabilities ./bolt/capabilities.json \
    --deployment ./bolt/deployment.json
done
```

For the client, run `vite` normally and proxy `/api/*` and `/auth/*`
to your Bolt's autogen URL in `vite.config.ts`. Or skip the proxy
and call the Bolt URL directly with CORS headers.

### 6. Custom domain (optional)

If you want `https://my-app.<env>.raindb.gignit.com` (or any other
hostname pointed at the bolt-ALB), publish with `--domain`:

```bash
raindb-cli --profile core.<env>.my-app lightning bolt publish \
  --source ./bolt --name my-app --auto-routes --domain my-app.<env>.raindb.gignit.com \
  ...
```

This sets the manifest's `domain` field and tells genesis to add
a matching ALB host-header rule. You still need to add a Route53
record (A-alias or CNAME) pointing the hostname at the bolt-ALB
unless the domain falls inside a controlled zone (the apex swap
happens automatically for `<env>.raindb.gignit.com`-style names).
The publish output includes a `dnsInstructions` block with the
exact AWS CLI commands when manual DNS is needed.

**First-claim flow.** The FIRST time any tenant publishes a bolt
with a brand-new `--domain`, the publish output includes a
one-time `NewDomainKey` value:

```
NewDomainKey: hL+fIImo2U8HtMny4pBUwGuyx50EtaDagnwM7wQkXao=
              ^-- ONE-TIME disclosure. Save this if you may need to
                  transfer the domain to another tenant later.
```

This is the domain-ownership key. It's stored encrypted-at-rest
on both your tenant AND the platform tenant; you don't NEED to
save it (republishes auto-resolve from your tenant's
lightning-secrets formation). Save it only if you plan to transfer
the domain to another tenant later. See section "Custom domain
ownership" below for the full model.

**Cross-tenant hijack defense.** A different tenant attempting
to publish a bolt with the same `--domain` is rejected by the
resolver with:

```
error: publishBolt: domain "<x>" is already claimed by a
different bolt; supply the matching domainKey for legitimate
transfer
```

The defense lives in the `publishBolt` mutation's pre-write
gate -- the rejection happens BEFORE any droplet is written, so
the routing for the legitimate bolt is never disturbed.

**Same-tenant multi-bolt-per-domain works automatically.** If
you want multiple bolts in the same tenant to share a domain
(for future explicit-route composition), publish each one with
the same `--domain`; the resolver's auto-inject path supplies
the key from your tenant's lightning-secrets each time.

---

## How-to: common tasks

### Read a droplet

```typescript
import type { BoltCtx } from "./types";

function getUser(ctx: BoltCtx, email: string) {
  const url = ctx.secrets.get("my_app_api_key_url"); // raindb-api graphql endpoint
  const apiKey = ctx.secrets.get("my_app_api_key");

  const res = ctx.fetch(url, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `
        query ReadLatest($input: ReadLatestInput!) {
          readLatest(input: $input) {
            dropletId payload
          }
        }
      `,
      variables: {
        input: { formationId: "my-app-user", indexId: "by-email-latest", scopeValue: email },
      },
    }),
  });

  const data = JSON.parse(res.body);
  return data?.data?.readLatest?.payload || null;
}
```

`ctx.fetch` is **synchronous** in goja. No `await`. The response
has `.status`, `.headers`, `.body` (string).

### Mint a JWT

```typescript
const claims = { userId: "...", email: "...", role: "user" };
const token = ctx.jwt.sign("my_app_jwt_secret", claims, 86400); // 1 day
```

### Verify a password

```typescript
const hash = ctx.crypto.hashPassword(plaintext, 12);
const ok = ctx.crypto.verifyPassword(plaintext, hash);
```

### Serve static assets (SPA)

In `bolt/routes.json`:

```json
[
  { "method": "GET",  "path": "/api/*",  "handler": "onHttpRequest" },
  { "method": "POST", "path": "/api/*",  "handler": "onHttpRequest" },
  { "method": "GET",  "path": "/auth/*", "handler": "onHttpRequest" },
  { "method": "POST", "path": "/auth/*", "handler": "onHttpRequest" },
  { "static": { "path": "/assets/*", "publicAsset": "assets/" } },
  { "static": { "path": "/*",        "publicAsset": "index.html" } }
]
```

Stage `bolt/client/dist/` (from `vite build`) before publishing.
The publisher bundles it into the Bolt's asset tree.

### Call raindb-api's REST surfaces

raindb-api exposes canonical REST endpoints for marketplace,
LLM providers, formations, and more. **Prefer these over rolling
your own SQL** -- they exist precisely so consumers don't
reimplement projection logic that already lives in the platform.

```typescript
const apiBase = ctx.secrets.get("my_app_api_base"); // "http://localhost:8080" or remote
const res = ctx.fetch(`${apiBase}/api/marketplace/packs`, {
  method: "GET",
  headers: { "X-API-Key": ctx.secrets.get("my_app_api_key") },
});
return { status: res.status, body: JSON.parse(res.body) };
```

This is the pattern raindb-app's marketplace routes use. ~80
lines of proxy code instead of ~230 lines of duplicated SQL.

### Custom domain ownership

When a Bolt is published with `--domain <hostname>`, the
`publishBolt` mutation enforces ownership via a per-domain
secret in the existing `lightning-secrets` formation.

**Read your tenant's domain key.** Auto-decrypts on read:

```bash
raindb-cli --profile <your-profile> droplet read-latest \
  lightning-secrets by-name-latest 'domainKey:<domain>'
```

The `value` field is the plaintext key.

**Cross-tenant transfer.** When tenant A wants to hand a custom
domain to tenant B:

1. Tenant A reads their `domainKey:<domain>` value (above).
2. A hands the plaintext to B out-of-band.
3. B publishes with the manifest's `payload.domainKey` field
   set to the supplied plaintext (e.g. by editing the bolt's
   source or via a custom publish wrapper). The resolver
   pre-write gate verifies B's supplied key matches the
   platform-side claim and accepts the transfer; routing for
   the domain follows B's new bolt droplet.
4. The resolver also writes the key to B's lightning-secrets
   so B's subsequent republishes auto-resolve.
5. Optional: A deletes their stale lightning-secrets entry
   once transfer is confirmed.

**Same-tenant multi-bolt-per-domain.** Architectural-level
supported today; routing composition between multiple bolts at
the same domain (e.g. one bolt handles `/auth/*`, another
handles `/api/*`) requires future routing-layer work that
isn't yet shipped. The ownership claim model doesn't block it.

For the full architecture see
`raindb-phoenix-lightning/docs/RAINDB_CUSTOM_DOMAIN.md` section
"Domain ownership claims (FD-65 -- shipped)" and FD-65 in
`raindb-phoenix-lightning/docs/RAINDB_PHX_LIGHTNING.md`.

---

## DO / DO NOT

### DO

- **Browse the Marketplace before writing anything.** If a pack
  exists, use it.
- **Use `readLatest` / `writeDroplet` / `readToken` for platform
  reads.** SQL is for your own entity tables; bridged-from-platform
  formations are unreliable from SQL on non-platform tenants.
- **Walk indexes for "list all X" patterns.** `listAllKeys("indexes/
  <formation>/by-<index>/")` + per-id `readLatest` is the canonical
  Tier 2.5 pattern.
- **Declare every secret in `capabilities.json`.** The runtime
  refuses to read undeclared names.
- **Use `--profile <env>` to target different environments.** Same
  publish command, different profile. Don't hardcode endpoint URLs.
- **Reuse `BoltID` across republishes.** The CLI matches by name
  automatically; save the `BoltID` from the first publish if you
  want to be explicit.
- **Match raindb-api's canonical surfaces when proxying.** Marketplace,
  LLM providers, formation discovery -- raindb-api has REST endpoints
  for these. Use them; don't reimplement.

### DO NOT

- **Don't use `process.env.X`.** The goja sandbox has no env.
  Substitute `ctx.secrets.get("name")`.
- **Don't pull in Node-only deps.** `fs`, `child_process`,
  `bcrypt` (npm), native binaries -- all fail at runtime. Use
  `ctx.crypto`, `ctx.jwt`, `ctx.ids`, `ctx.cookies` instead.
- **Don't `await ctx.fetch(...)`.** It's sync. Returns immediately
  with `.status` / `.body`. Mixing `await` works but adds noise.
- **Don't run SQL against bridged platform formations from a non-
  platform tenant.** The view may not be registered locally; you'll
  get either "table does not exist" or null projections. Use
  `readLatest` or proxy raindb-api's canonical handler.
- **Don't put the `static` route's path outside the static object.**
  It's `{"static": {"path": "/*", "publicAsset": "index.html"}}`,
  NOT `{"path": "/*", "static": {"publicAsset": "..."}}`. The wrong
  shape gets silently ignored by the dispatcher.
- **Don't use `--auto-routes` if your app has non-`/api/*` paths**
  (like `/auth/*`). Auto-routes only registers `/api/*` + statics.
  Write explicit `routes.json` for everything else.
- **Don't assume `executeSQL` rows are array-of-arrays.** Phoenix
  returns array-of-objects in some paths. Normalize via the helper
  function in your `raindb.ts` (sniff `Array.isArray(rows[0])`).
- **Don't try to install your Bolt's tenant on the platform tenant
  itself.** The publish path requires a bridge between source tenant
  and platform; the platform tenant doesn't have one to itself.
  Use a dedicated tenant.

---

## Troubleshooting

### `route_not_found` for static asset paths

The dispatcher requires `{"static": {"path": ..., "publicAsset": ...}}`.
Path goes INSIDE the static object. See "DO NOT" above.

### `Table with name <foo> does not exist`

You're running SQL against a formation that isn't registered in the
periscope view for the calling tenant. Either:
- Pass `--formationId` hint to executeSQL (triggers prelude attach)
- Switch to `readLatest` / `writeDroplet` -- the GraphQL ops work
  through the bridge automatically
- If it's a marketplace / LLM provider read, use raindb-api's REST
  surface instead of rolling your own SQL

### `bridge mirror forward to ... not found`

You're publishing to a tenant that doesn't have a bridge to the
platform tenant. Bolts run on tenants WITH a bridge auto-provisioned
on `tenant create`. The platform tenant itself doesn't have a
bridge to itself; publish to a different tenant.

### Bolt returns null values for every field

Almost always: your SQL returned the right column SHAPE but the
view projection is misbehaving on the calling tenant. Switch from
SQL to `readLatest` (for single-record reads) or proxy raindb-api
(for catalog-style reads). See the marketplace lesson in raindb-
app's git history for the canonical fix pattern.

### Custom domain returns `route_not_found`

Genesis hasn't finished provisioning the ALB listener rule, OR
your Route53 record isn't pointing at the bolt-ALB yet. Check:
1. The published manifest's `customDomainStatus` field
2. `dig <hostname>` -- it should resolve to the bolt-ALB's IPs
3. The `dnsInstructions` block in your publish output -- it has
   the exact Route53 change-batch JSON

### Publish fails with `domain "<x>" is already claimed by a different bolt`

The domain you're trying to claim is already owned by another
tenant. Two cases:

- **Domain is owned by you in a DIFFERENT tenant.** You need to
  transfer ownership: read the `domainKey:<domain>` value from
  the owning tenant's lightning-secrets (auto-decrypts on read),
  then publish from the target tenant with the manifest's
  `payload.domainKey` set to that plaintext. The resolver
  pre-write gate verifies and accepts the transfer.

- **Domain is owned by someone else.** The publish is correctly
  rejected. You can either pick a different domain or contact
  the owning tenant for a legitimate transfer.

The error fires at the resolver's pre-write gate, so no droplet
is written and the legitimate bolt's routing is undisturbed.

### Stats emission warnings (`drop-tolerant`) -- not seen anymore

The first publish of a Bolt no longer logs
`lightning-bolt-stats ... not found` warnings. As of FD-65, the
publishBolt mutation ensures the lightning-bolt-stats token
droplet exists server-side BEFORE the bolt droplet is written;
the dispatcher's first invocation lands on a populated token.
If you see these warnings, you're likely on a pre-FD-65 build
of the platform.

---

## Reference apps to copy from

- **`~/src/raindb-app/bolt/`** -- the RainDB Platform dashboard Bolt.
  Full identity + tenant management surface. 67 routes. Canonical
  reference for any auth-heavy app.
- **`~/src/fdn-app/bolt/`** -- the Foundation document-store Bolt.
  CRUD on projects / folders / documents / agents. Canonical
  reference for any content-heavy app.

Both bolts have been live-tested through their full surfaces on
devx. The architectural patterns they share are documented above.
The patterns that differ (raindb-app proxies a lot; fdn-app
agent-runs) reflect their different surface choices, not different
correct ways to write a Bolt.

---

## Where to ask questions

- **Architecture / new pattern questions**: read the reference Bolts
  first. If still stuck, the marketplace `guide-patterns` pack
  contains long-form rationale for platform-wide design decisions.
- **CLI questions**: `raindb-cli help` and `raindb-admin help` are
  thorough. Every subcommand has `--help`.
- **Bug reports / feature requests**: the RainDB Phoenix repo
  (`~/src/raindb-phoenix-lightning/` if you have it locally).
