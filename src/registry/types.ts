// types.ts -- public contract for the agent runtime + tool registry.
//
// These types implement the RainDB tool registration contract.
// Wire shapes seen by the model must match across surfaces so a
// tool invoked from raindb-cli and the same tool invoked from a
// TS agent are substitutable.
//
// Node consumers (host applications) bind to these. Changing the
// public exports is a breaking change.

import type { AgentHost } from '../host/types.js';

export type { AgentHost };

/**
 * Per-tenant credentials passed on every GraphQL call. The host
 * (any Node consumer) populates this on each agent turn from
 * whatever auth surface it owns. The package never reads env vars
 * directly; the caller's resolution chain is the single source of
 * truth.
 */
export interface GraphQLOptions {
  /**
   * Tenant API key (rdb_*). Sent as `X-API-Key` header on the
   * GraphQL request and as `Authorization: Bearer ...` on the
   * openai-spec REST surface (the RainDB API accepts both).
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
 * The default scale is a three-rung ladder. Hosts that need
 * a different policy (e.g. finer admin distinctions) can extend
 * this union via TypeScript module augmentation OR pass their own
 * role string -- the comparator (`buildToolDefs`) is pluggable.
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
   * Host adapter providing transport (fetch + chat completion) +
   * structured logging. Tools call `ctx.host.fetch(...)` instead
   * of `globalThis.fetch(...)` so non-Node consumers (Lightning
   * bolt sandboxes) can inject their own transport.
   *
   * Node consumers populate via `makeNodeHost(creds)`. The Lightning
   * bolt host wraps the bolt sandbox's ctx.fetch.
   *
   * Required. Constructors that don't set it should call
   * `ensureHost(ctx)` to auto-fill the Node host (the common case
   * for existing Node consumer code paths).
   */
  host: AgentHost;
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
   * Opaque host extension. A host application stuffs project/folder
   * context here for its own product tools; another does the same
   * with its own state. The shared tools never read this.
   */
  product?: Record<string, unknown>;
  /**
   * Base URL of the marketplace REST API on the RainDB API
   * (`/api/marketplace/*`).
   *
   * Auth model: the RainDB API gates `/api/marketplace/*`. Fetch
   * calls MUST send `X-API-Key: <caller tenant key>` (the
   * marketplace tools pull it from `ctx.creds.apiKey`). The caller
   * identity is used for authn / observability only; the actual
   * data source is resolved server-side. The caller never sees the
   * marketplace tenant's creds.
   *
   * From the agent tool's perspective the surface is plain HTTP GET.
   *
   * Required when calling marketplace tools (pack_list,
   * pack_info, pack_get, pack_features, vendor_list,
   * vendor_info). Absence is an explicit error per the
   * "no fallbacks" principle, not a silent fallback to a
   * default URL. Hosts populate this per turn from their env.
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
 * tool-error so the model can retry or explain. Following the RainDB
 * tool registration contract: thrown exceptions correspond to an
 * invocation error return, and returned objects with an `error`
 * field correspond to a tool-call result carrying an error.
 */
export type ToolFn = (
  ctx: ToolContext,
  args: ToolArgs,
) => Promise<unknown>;

/**
 * JSON-Schema parameter shape for one tool. Mirrors openai-spec's
 * function-tool schema 1:1. The agent loop forwards this verbatim
 * to ai.chat.completions.create.
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
 * One registered tool. Implements the RainDB tool registration
 * contract field-for-field:
 *
 *   registration field   | TS field
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
 * shape (e.g. forward each event as one SSE frame, or print a
 * thinking-trace in a CLI).
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
