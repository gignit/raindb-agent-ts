// loop/index.ts -- the agent loop. Runs over an AgentHost's
// chatCompletion surface.
//
// The generic loop here drops host-specific machinery (side-effect
// callbacks, structured-result allow-list, session-title events).
// Hosts that need richer events subscribe via `onEvent` and
// translate to their own UI/SSE shape.
//
// The loop:
//   1. Send system prompt + history + user prompt to
//      ctx.host.chatCompletion()
//   2. If the response carries tool_calls: execute each via
//      `findTool`, append a `{role:'tool', tool_call_id,
//      content: JSON.stringify(result)}` message, then loop.
//   3. If the response is plain content: emit it as the final
//      answer and stop.
//   4. Iteration cap prevents runaways. Default 50; callers can
//      override per-request and the host can configure a higher
//      ceiling via `maxIterations`.
//
// Host independence: the loop has zero knowledge of openai-node,
// global fetch, or any provider's API shape. ctx.host's
// chatCompletion call drives every LLM round-trip. Node consumers
// inject makeNodeHost(creds) (which wraps openai-node); Lightning
// bolt consumers inject a bolt-sandbox host that calls ctx.fetch.

import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from '../host/types.js';
import type {
  AgentEvent,
  RegisteredTool,
  ToolArgs,
  ToolConfirmFn,
  ToolContext,
  ToolEvent,
} from '../registry/types.js';
import { ensureHost } from '../registry/ensureHost.js';
import {
  buildToolDefs,
  defaultRoleAllows,
  findTool,
} from '../registry/build.js';
import { resolveDefaultChatModel } from '../client/raindbAi.js';

/**
 * Hard cap so a misconfigured model config or a runaway agent
 * can't burn unbounded LLM cost. Mirrors the RainDB platform's
 * iteration hard cap.
 */
const MAX_ITERATIONS_HARD_CAP = 2000;

/** Conservative fallback when no caller-supplied cap is provided. */
const DEFAULT_MAX_ITERATIONS = 50;

export interface RunAgentOptions {
  /** System prompt fed first in the conversation. Required. */
  systemPrompt: string;
  /** The user's new message for this turn. Required. */
  userPrompt: string;
  /**
   * Prior conversation turns as openai-spec messages. Each entry
   * must be a system/user/assistant param (no `tool` role -- tool
   * results are reconstructed by the agent loop on each turn).
   */
  history?: ChatCompletionMessageParam[];
  /** Per-turn execution context populated by the host. */
  ctx: ToolContext;
  /**
   * The full tool catalog this turn may pull from. The loop
   * filters by `ctx.role` before sending to the model. When empty
   * or omitted the model runs without tools (a plain chat call).
   */
  tools?: RegisteredTool[];
  /**
   * Caller-supplied chat model id. When unset, the loop resolves
   * the platform default via the RainDB API (cached 5min).
   */
  model?: string;
  /**
   * Per-request iteration cap. Clamped to [1, MAX_ITERATIONS_HARD_CAP].
   * Default DEFAULT_MAX_ITERATIONS when unset.
   */
  maxIterations?: number;
  /**
   * Confirmation callback for `modifiesResource: true` tools.
   * Hosts typically inject an interactive prompt (UI / CLI) or
   * auto-yes (skip-permissions paths). When undefined, all
   * mutating tools execute without prompt.
   */
  confirm?: ToolConfirmFn;
  /** Event sink. Each loop phase emits one event. */
  onEvent?: (e: AgentEvent) => void;
}

export interface AgentResult {
  /** The model's final assistant content. */
  content: string;
  iterations: number;
  toolCallsTotal: number;
  durationMs: number;
  /**
   * Full openai-spec message history including all tool calls +
   * tool results from this turn. Hosts can persist subsets of this
   * for follow-up runs.
   */
  history: ChatCompletionMessageParam[];
  /** Per-tool-call records useful for chat-history persistence. */
  toolEvents: ToolEvent[];
  /**
   * Token accounting, summed across every chatCompletion call this run
   * made (multiple when tools iterate). Absent when the provider returned
   * no usage on any call. Hosts surface this for cost/usage diagnostics.
   */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Run one agent turn. The function is fully self-contained: it
 * builds its own openai-node client from `ctx.creds`, resolves the
 * chat model on its own, and returns when the model emits a
 * tool-less response or the iteration cap fires.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const start = Date.now();
  const onEvent = opts.onEvent ?? noop;

  // Build the initial message stack: system prompt first, then
  // any prior conversation history, then the user's new prompt.
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: opts.systemPrompt },
    ...(opts.history ?? []),
    { role: 'user', content: opts.userPrompt },
  ];

  // Normalize ctx so host is populated. Node consumers who built
  // the ctx without a host get a Node host auto-filled; bolt
  // consumers and tests that pre-populate host pass through
  // unchanged.
  const ctx = ensureHost(opts.ctx);

  const catalog = opts.tools ?? [];
  const tools = buildToolDefs(catalog, ctx.role, defaultRoleAllows);

  const toolEvents: ToolEvent[] = [];
  let totalToolCalls = 0;

  // Token accounting, summed across every chatCompletion call. Stays
  // undefined unless at least one provider response carried usage.
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let sawUsage = false;
  const usageOut = () =>
    sawUsage ? { promptTokens, completionTokens, totalTokens } : undefined;

  const maxIterations = clampIterations(opts.maxIterations);

  // Resolve the chat model once per turn. Switching models mid-loop
  // would make the conversation history incoherent.
  const model = opts.model
    ?? (await resolveDefaultChatModel(ctx.creds, ctx.host));

  // openai-spec ChatCompletionTool shape forwarded verbatim to
  // host.chatCompletion. buildToolDefs returns openai-node's typed
  // shape; cast to our internal ChatCompletionTool (structurally
  // identical -- both are {type: 'function', function: {name,
  // description?, parameters}}).
  const chatTools: ChatCompletionTool[] = tools as unknown as ChatCompletionTool[];

  for (let iter = 1; iter <= maxIterations; iter += 1) {
    onEvent({ type: 'thinking', iteration: iter });

    const completion = await ctx.host.chatCompletion({
      model,
      temperature: 0.2,
      messages,
      tools: chatTools.length > 0 ? chatTools : undefined,
    });

    // Accumulate token usage when the provider reported it.
    if (completion.usage) {
      sawUsage = true;
      promptTokens += completion.usage.prompt_tokens ?? 0;
      completionTokens += completion.usage.completion_tokens ?? 0;
      totalTokens += completion.usage.total_tokens ?? 0;
    }

    const choice = completion.choices[0];
    const assistantMsg = choice?.message;
    const respContent = assistantMsg?.content ?? '';
    const respToolCalls = assistantMsg?.tool_calls;

    // No tool calls -> final answer.
    if (!respToolCalls || respToolCalls.length === 0) {
      onEvent({
        type: 'final',
        content: respContent,
        iterations: iter,
        toolCalls: totalToolCalls,
        durationMs: Date.now() - start,
      });
      return {
        content: respContent,
        iterations: iter,
        toolCallsTotal: totalToolCalls,
        durationMs: Date.now() - start,
        history: messages,
        toolEvents,
        usage: usageOut(),
      };
    }

    // Append the assistant message verbatim so the next turn's
    // tool-result entries reference valid tool_call_ids.
    messages.push({
      role: 'assistant',
      content: respContent,
      tool_calls: respToolCalls,
    });

    for (const call of respToolCalls) {
      totalToolCalls += 1;

      // openai-spec tool calls are a tagged union; only `function`-
      // typed calls are supported by raindb's tool registry.
      if (call.type !== 'function') {
        const errMsg = `tool ${call.id}: openai 'custom' tool type is not supported by raindb's tool registry; use a function-typed tool instead`;
        onEvent({ type: 'tool-error', iteration: iter, toolName: '?', error: errMsg });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: errMsg }),
        });
        toolEvents.push({ toolName: call.id, args: {}, result: { error: errMsg }, ok: false });
        continue;
      }

      const fn = call.function;
      const toolName = fn.name;

      // openai-spec arguments are a JSON-encoded STRING. Parse
      // before passing; surface bad-arguments via tool-result so
      // the model can retry.
      let callArgs: ToolArgs = {};
      const rawArgs = fn.arguments;
      if (typeof rawArgs === 'string' && rawArgs.length > 0) {
        try {
          callArgs = JSON.parse(rawArgs) as ToolArgs;
        } catch {
          const errMsg = `tool ${toolName}: arguments are not valid JSON`;
          onEvent({ type: 'tool-error', iteration: iter, toolName, error: errMsg });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: errMsg }),
          });
          toolEvents.push({
            toolName,
            args: { _rawArguments: rawArgs },
            result: { error: errMsg },
            ok: false,
          });
          continue;
        }
      } else if (rawArgs && typeof rawArgs === 'object') {
        callArgs = rawArgs as ToolArgs;
      }

      const tool = findTool(catalog, toolName);
      onEvent({ type: 'tool-call', iteration: iter, toolName, args: callArgs });

      if (!tool) {
        const errMsg = `unknown tool: ${toolName}`;
        onEvent({ type: 'tool-error', iteration: iter, toolName, error: errMsg });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: errMsg }),
        });
        toolEvents.push({ toolName, args: callArgs, result: { error: errMsg }, ok: false });
        continue;
      }

      // Confirm gate for mutating tools. Hosts inject an
      // interactive prompt or auto-yes; when undefined, mutating
      // tools execute without prompt.
      if (tool.modifiesResource && opts.confirm) {
        let allowed = false;
        try {
          allowed = await opts.confirm({ toolName, args: callArgs, ctx });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          onEvent({ type: 'tool-error', iteration: iter, toolName, error: `confirm callback threw: ${errMsg}` });
          allowed = false;
        }
        if (!allowed) {
          const errMsg = 'tool call denied by user';
          onEvent({ type: 'tool-error', iteration: iter, toolName, error: errMsg });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: errMsg }),
          });
          toolEvents.push({ toolName, args: callArgs, result: { error: errMsg }, ok: false });
          continue;
        }
      }

      const t0 = Date.now();
      try {
        const result = await tool.execute(ctx, callArgs);
        const text = JSON.stringify(result);
        const preview = text.length > 200 ? text.slice(0, 200) + '...' : text;
        onEvent({
          type: 'tool-result',
          iteration: iter,
          toolName,
          durationMs: Date.now() - t0,
          ok: true,
          preview,
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: text,
        });
        toolEvents.push({ toolName, args: callArgs, result, ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        onEvent({ type: 'tool-error', iteration: iter, toolName, error: msg });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: msg }),
        });
        toolEvents.push({ toolName, args: callArgs, result: { error: msg }, ok: false });
      }
    }
  }

  // Hit the iteration cap.
  const fallback = 'I was unable to complete this within the tool-call budget. Please refine your request.';
  onEvent({
    type: 'final',
    content: fallback,
    iterations: maxIterations,
    toolCalls: totalToolCalls,
    durationMs: Date.now() - start,
  });
  return {
    content: fallback,
    iterations: maxIterations,
    toolCallsTotal: totalToolCalls,
    durationMs: Date.now() - start,
    history: messages,
    toolEvents,
    usage: usageOut(),
  };
}

function noop(): void {}

function clampIterations(override: number | undefined): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.min(override, MAX_ITERATIONS_HARD_CAP);
  }
  return DEFAULT_MAX_ITERATIONS;
}
