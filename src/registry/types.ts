// types.ts -- public contract for the agent runtime + tool registry.
//
// These types mirror the Go reference at
// raindb-phoenix-oc/internal/ai/registry.go::Registration and
// pkg/llm/types.go::ToolParameters. Wire shapes seen by the model
// must match between the Go and TypeScript surfaces so a tool
// invoked from raindb-cli and the same tool invoked from a
// TS-portal agent are substitutable.
//
// Two consumers (fdn-app, raindb-app) bind to these. Changing the
// public exports is a breaking change.

/**
 * Per-tenant credentials passed on every GraphQL call. The host
 * (fdn-app, raindb-app, or any future consumer) populates this on
 * each agent turn from whatever auth surface it owns. The package
 * never reads env vars directly; the caller's resolution chain is
 * the single source of truth.
 */
export interface GraphQLOptions {
  /**
   * Tenant API key (rdb_*). Sent as `X-API-Key` header on the
   * GraphQL request and as `Authorization: Bearer ...` on the
   * openai-spec REST surface (raindb-api accepts both).
   */
  apiKey?: string;
  /**
   * Optional GraphQL endpoint override. When unset the host's
   * environment provides it. The package does NOT read process.env
   * directly -- callers are responsible for the resolution chain
   * (per-process default, per-request override, etc.).
   */
  endpoint?: string;
}

/**
 * Tool role gating. Hosts assign one role per agent turn based on
 * the caller's permissions. Tools declare a `minRole`; the registry
 * filters out anything above the caller's grant.
 *
 * The default scale is fdn-app's three-rung ladder. Hosts that need
 * a different policy (raindb-app uses platform-admin distinctions)
 * can extend this union via TypeScript module augmentation OR pass
 * their own role string -- the comparator (`buildToolDefs`) is
 * pluggable.
 */
export type ToolRole = 'read' | 'write' | 'admin';

/**
 * The execution context every tool receives. Hosts populate this
 * before each agent turn. The package treats `product` as opaque;
 * host-specific tools use it to thread their own data through.
 */
export interface ToolContext {
  /**
   * Per-request tenant credentials. Every tool's GraphQL call MUST
   * pass this through unchanged so bridge dispatch + audit logging
   * see the right tenant identity.
   */
  creds: GraphQLOptions;
  /**
   * The role the host granted for this turn. Used by the registry
   * filter; tools themselves may also branch on it for permission-
   * aware behaviour (rare).
   */
  role: ToolRole;
  /**
   * Stable identity of the human (or service) on whose behalf this
   * agent turn runs. Surfaced in error messages and used by some
   * tools as the `author` field on droplet writes.
   */
  userId?: string;
  /**
   * Opaque host extension. fdn-app stuffs project/folder context
   * here for its own product tools; raindb-app does the same with
   * its own state. The shared tools never read this.
   */
  product?: Record<string, unknown>;
  /**
   * Base URL of the marketplace REST API on **raindb-api**
   * (`/api/marketplace/*`). Per FINAL DECISION S.1 (in raindb-
   * phoenix-oc/docs/BRIDGE_REFACTOR_PLAN.md): marketplace lives
   * on raindb-api at :8080, NOT on raindb-app at :4000. This is
   * a post-S.1 detail; pre-S.1 the surface was on raindb-app and
   * was anonymous-readable, and this comment used to say so.
   *
   * Auth model: raindb-api's authMiddleware gates `/api/
   * marketplace/*`. Fetch calls MUST send `X-API-Key: <caller
   * tenant key>` (the marketplace tools pull it from `ctx.creds.
   * apiKey`). The caller identity is used for authn /
   * observability only; the actual data source is the marketplace
   * tenant, resolved server-side via `platform_marketplace_
   * credential` (the credentialed cross-tenant pattern shipped in
   * phoenix commit 2ee476a). The caller never sees the
   * marketplace tenant's creds.
   *
   * Data layer: list reads use Tier 3 periscope SQL
   * (`runMarketplaceSQL` against `entity."platform_marketplace_
   * pack"`); detail reads use direct ReadLatest on by-vendor-
   * pack-version / by-id-latest indexes (O+1 pattern). All of
   * this happens inside the REST handler; from the agent tool's
   * perspective the surface is plain HTTP GET.
   *
   * Required when calling marketplace tools (pack_list,
   * pack_info, pack_get, pack_features, vendor_list,
   * vendor_info). Absence is an explicit error per the
   * "no fallbacks" principle, not a silent fallback to a
   * default URL. Hosts populate this per turn from their
   * env (fdn-app: `RAINDB_API_URL`, default
   * http://localhost:8080; raindb-app: relative -- same host).
   */
  marketplaceBaseUrl?: string;
}

/**
 * The argument shape every tool's `execute` receives. Args come
 * from the LLM as a JSON-decoded object whose shape matches the
 * tool's declared `parameters`. The package does not validate
 * the shape against the schema beyond the openai-spec parse;
 * tools defensively coerce + validate inside their own bodies.
 */
export type ToolArgs = Record<string, unknown>;

/**
 * The execute function signature. Tools return any JSON-serializable
 * value; the agent loop stringifies it for the model. Errors thrown
 * here are caught by the loop and surfaced to the model as a
 * tool-error so the model can retry or explain. Mirrors the Go
 * `Invoke func(ctx, args) (ToolCallResult, error)` shape: TS
 * exceptions correspond to the Go error return, returned objects
 * with an `error` field correspond to `ToolCallResult{Error: ...}`.
 */
export type ToolFn = (
  ctx: ToolContext,
  args: ToolArgs,
) => Promise<unknown>;

/**
 * JSON-Schema parameter shape for one tool. Mirrors openai-spec's
 * function-tool schema and Go's `llm.ToolParameters` 1:1. The
 * agent loop forwards this verbatim to ai.chat.completions.create.
 */
export interface ToolParameters {
  type: 'object';
  /**
   * Per-property JSON schema. Keys are parameter names; values
   * carry type + description + optional enum/items/nested
   * properties. We keep the shape loose (one nested level deep is
   * the common case; more is allowed) -- model providers handle
   * the wire form.
   */
  properties?: Record<string, ToolProperty>;
  required?: string[];
}

export interface ToolProperty {
  type: string;
  description?: string;
  enum?: string[];
  /** For array-typed parameters. */
  items?: ToolProperty;
  /** For object-typed parameters. */
  properties?: Record<string, ToolProperty>;
  required?: string[];
}

/**
 * One registered tool. Mirrors the Go `Registration` struct in
 * `internal/ai/registry.go` field-for-field:
 *
 *   Go field             | TS field
 *   ---------------------+------------------
 *   Name                 | name
 *   Description          | description
 *   ModifiesResource     | modifiesResource
 *   Schema               | parameters
 *   Invoke               | execute
 *
 * Naming convention: `<domain>_<verb>` snake_case. Match the CLI
 * subcommand path with underscores -- `raindb-cli pack list`
 * becomes `pack_list`. The model relies on this convention for
 * routing.
 */
export interface RegisteredTool {
  /** Tool name, snake_case, matching the CLI verb path. */
  name: string;
  /**
   * Description shown to the model when deciding whether to call.
   * State the result type, the inputs, and the equivalent CLI verb.
   * Avoid taglines or marketing prose -- they cost tokens on every
   * agent round and don't help routing.
   */
  description: string;
  /**
   * Minimum role required to invoke. The registry filter compares
   * caller's `ctx.role` against this; tools above the caller's
   * grant are not even shown to the model.
   */
  minRole: ToolRole;
  /**
   * JSON-schema parameter declaration. Forwarded verbatim to
   * openai-spec function-tool definitions.
   */
  parameters: ToolParameters;
  /**
   * Set on every mutating tool. The agent loop's confirm closure
   * gates these calls -- hosts can interpose an interactive prompt
   * (CLI/UI) or auto-yes (skip-permissions paths) before the call
   * fires. Tools that only read data leave this `false` (or omit).
   */
  modifiesResource?: boolean;
  /**
   * The actual implementation. Receives the populated context +
   * the args object the LLM emitted. Returns a JSON-serializable
   * result; the loop stringifies it for the model.
   */
  execute: ToolFn;
}

/**
 * Streaming agent-loop event surface. Hosts subscribe via
 * `runAgent({ onEvent })`. Each event corresponds to one phase
 * in the agent loop; consumers translate to their own UI/SSE
 * shape (fdn-app forwards each event as one SSE frame; CLIs print
 * a thinking-trace; raindb-app's portal will mirror fdn-app).
 */
export type AgentEvent =
  | { type: 'thinking'; iteration: number }
  | {
      type: 'tool-call';
      iteration: number;
      toolName: string;
      args: ToolArgs;
    }
  | {
      type: 'tool-result';
      iteration: number;
      toolName: string;
      durationMs: number;
      ok: boolean;
      preview?: string;
      result?: unknown;
    }
  | {
      type: 'tool-error';
      iteration: number;
      toolName: string;
      error: string;
    }
  | {
      type: 'final';
      content: string;
      iterations: number;
      toolCalls: number;
      durationMs: number;
    };

/**
 * One executed tool call's record, returned in `AgentResult.toolEvents`.
 * Hosts persist these to chat-history for later replay.
 */
export interface ToolEvent {
  toolName: string;
  args: ToolArgs;
  result: unknown;
  ok: boolean;
}

/**
 * Confirm callback signature for `modifiesResource: true` tools.
 * Hosts inject this into `RunAgentOptions.confirm`; the loop
 * consults it before each mutating tool's execute() runs. Return
 * `true` to allow, `false` to deny. When undefined, all mutating
 * tools execute without prompt (suitable for trusted contexts
 * like raindb-cli's `--skip-permissions`).
 */
export type ToolConfirmFn = (input: {
  toolName: string;
  args: ToolArgs;
  ctx: ToolContext;
}) => Promise<boolean> | boolean;
