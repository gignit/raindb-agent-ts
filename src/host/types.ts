// host/types.ts -- the AgentHost interface and the openai-spec-shaped
// request/response types runAgent + tools depend on.
//
// The package decouples its dependency on Node primitives (global
// fetch, openai-node) by funneling every outbound call through an
// AgentHost. Node consumers pass `makeNodeHost(creds)`. Non-Node
// consumers (Lightning bolts) inject their own host
// that wraps `ctx.fetch` and an LLM provider call.
//
// Two known consumers today:
//   - Node consumers (Node BFF, uses makeNodeHost)
//   - the Lightning bolt sandbox (host implemented in Go)
//
// The AgentHost contract is the package's stable extension point.
// Adding a method is a breaking change; consumers must implement
// the full surface. Keep the surface minimal.
//
// === Field naming ===
//
// ChatCompletionRequest/Response preserve OpenAI's snake_case
// (tool_calls, tool_call_id, finish_reason) so wire payloads built
// from these types pass through to OpenAI's HTTP API unchanged.
// JS/TS devs reading code recognize the names; the Go-side bolt
// host can serialize directly without case translation.

/* eslint-disable @typescript-eslint/naming-convention */

/**
 * Per-host transport surface. Two methods (plus log) cover every
 * outbound call the package makes:
 *
 *   - `fetch`: HTTP transport for GraphQL + marketplace REST.
 *     Returns a host-agnostic `HostResponse` with `.text()` and
 *     `.json()` methods so the call shape is identical across Node
 *     (where it wraps global fetch) and the bolt sandbox (where it
 *     wraps `ctx.fetch`).
 *
 *   - `chatCompletion`: invoke an LLM provider's chat-completions
 *     endpoint. The Node host wraps openai-node; the bolt host
 *     builds the request body, calls the provider via `ctx.fetch`
 *     with `Authorization: Bearer <key>`, and parses the response.
 *
 *   - `log`: structured logging. Matches the shape Lightning's
 *     `ctx.log` exposes so the bolt host is a passthrough.
 */
export interface AgentHost {
  /**
   * HTTP fetch. Implementations MUST return a HostResponse whose
   * `text()` and `json()` methods are callable from the consumer
   * once the response body has been received.
   *
   * The Node host wraps `globalThis.fetch` and exposes its Response
   * object's `.text()`/`.json()` directly. The bolt host wraps
   * `ctx.fetch(url, init)` and adapts the response shape.
   */
  fetch(url: string, init?: HostFetchInit): Promise<HostResponse>;

  /**
   * Chat completion. The request is the same shape every modern
   * LLM provider's openai-spec endpoint accepts. The response
   * mirrors OpenAI's `ChatCompletion` envelope.
   *
   * Implementations are free to route to OpenAI directly, to a
   * RainDB API proxy, or to a non-OpenAI provider that translates
   * the request shape internally.
   */
  chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;

  /**
   * Structured logger. Signature matches Lightning's BoltCtx.log
   * so the bolt host can delegate without adaptation.
   */
  log: {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
  };
}

/**
 * Fetch init shape. Subset of the standard `RequestInit` covering
 * what the package's outbound calls need. Hosts that wrap a
 * standard fetch translate this directly; the bolt host translates
 * to its bolt-sandbox shape.
 */
export interface HostFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Host-agnostic HTTP response. Both Node and bolt hosts return this
 * shape so callers (executeGraphQL, fetchMarketplace, etc.) read
 * the body identically.
 *
 * `text()` and `.json()` are functions (not getters) for parity
 * with `globalThis.Response` AND the bolt-side sandbox binding which
 * also exposes them as functions.
 */
export interface HostResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string | string[]>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Chat completion types -- internal shapes that
// mirror openai-spec wire format. snake_case is intentional; do not
// camelCase these without updating every host implementation and
// every consumer that builds request bodies for direct LLM calls.
// ---------------------------------------------------------------------------

/**
 * A single chat-completion request. Mirrors OpenAI's
 * /v1/chat/completions shape, kept internal so the package isn't
 * coupled to openai-node's version drift and so non-OpenAI providers
 * can be wired without a translation layer at every call site.
 */
export interface ChatCompletionRequest {
  /** Model id (e.g. "raindb/sonnet"). */
  model: string;
  /** Conversation. System message first, then user/assistant/tool. */
  messages: ChatCompletionMessageParam[];
  /** Tool catalog for this turn. Omit for plain-chat (no tools). */
  tools?: ChatCompletionTool[];
  /** Tool routing preference. */
  tool_choice?: ChatCompletionToolChoice;
  /** Sampling temperature [0, 2]. Higher = more random. */
  temperature?: number;
  /** Hard cap on response length. */
  max_tokens?: number;
  /** Structured-output coercion. */
  response_format?: { type: 'text' | 'json_object' };
  /** Provider-specific knobs (top_p, presence_penalty, etc.). */
  [extra: string]: unknown;
}

/**
 * One message in a chat conversation. Roles are openai-spec.
 * Content can be a plain string OR a multimodal parts array (rare;
 * vision-aware models accept image_url parts).
 */
export type ChatCompletionMessageParam =
  | {
      role: 'system';
      content: string;
      name?: string;
    }
  | {
      role: 'user';
      content: string | ChatContentPart[];
      name?: string;
    }
  | {
      role: 'assistant';
      content: string | null;
      name?: string;
      tool_calls?: ChatCompletionMessageToolCall[];
    }
  | {
      role: 'tool';
      tool_call_id: string;
      content: string;
    };

/** Multimodal content part. v1 supports text + image_url. */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

/** Tool definition forwarded to the model. */
export interface ChatCompletionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

/** Tool routing preference. */
export type ChatCompletionToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

/** One model-emitted tool call inside an assistant message. */
export interface ChatCompletionMessageToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /**
     * The model's emitted argument JSON as a STRING. The agent
     * loop parses this; tools never see the raw string.
     */
    arguments: string;
  };
}

/**
 * The model's response. `choices[0]` is the assistant message we
 * act on. `usage` carries token accounting -- absent on some
 * providers, optional here.
 */
export interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionResponseMessage;
  finish_reason:
    | 'stop'
    | 'length'
    | 'tool_calls'
    | 'content_filter'
    | 'function_call'
    | string;
}

/** Response-side assistant message. Content may be null when the
 *  model is emitting tool_calls and no text. */
export interface ChatCompletionResponseMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ChatCompletionMessageToolCall[];
}
