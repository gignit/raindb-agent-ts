// host_adapter.test.ts -- runAgent with a directly-injected mock
// AgentHost (no global fetch involvement).
//
// The other loop test (loop.test.ts) mocks global fetch and uses
// the Node host transitively. That proves Node-path compatibility.
// This file proves the host abstraction itself: a host implemented
// from scratch (no openai-node, no fetch) drives runAgent through
// completion. It's the test the Lightning-side bolt host adapter
// (Go-implemented) needs to satisfy structurally too.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAgent } from '../../src/loop/index.js';
import {
  _resetDefaultModelCache,
} from '../../src/client/raindbAi.js';
import type {
  AgentHost,
  ChatCompletionRequest,
  ChatCompletionResponse,
  HostFetchInit,
  HostResponse,
  RegisteredTool,
  ToolContext,
} from '../../src/index.js';

interface FetchCall {
  url: string;
  init?: HostFetchInit;
}
interface ChatCall {
  req: ChatCompletionRequest;
}

interface MockHostState {
  fetches: FetchCall[];
  chats: ChatCall[];
  // Each call to host.fetch returns the next response in this queue;
  // exhausted queues throw.
  fetchResponses: Array<{ status: number; body: string }>;
  // Same shape for chatCompletion.
  chatResponses: ChatCompletionResponse[];
  logs: Array<{ level: 'info' | 'warn' | 'error'; msg: string; fields?: Record<string, unknown> }>;
}

function newMockHost(state: MockHostState): AgentHost {
  return {
    async fetch(url, init): Promise<HostResponse> {
      state.fetches.push({ url, init });
      const next = state.fetchResponses.shift();
      if (!next) {
        throw new Error(`mock host: no fetchResponses left for ${url}`);
      }
      return {
        status: next.status,
        ok: next.status >= 200 && next.status < 300,
        headers: { 'content-type': 'application/json' },
        async text() { return next.body; },
        async json() { return JSON.parse(next.body); },
      };
    },
    async chatCompletion(req): Promise<ChatCompletionResponse> {
      state.chats.push({ req });
      const next = state.chatResponses.shift();
      if (!next) {
        throw new Error('mock host: no chatResponses left');
      }
      return next;
    },
    log: {
      info(msg, fields) { state.logs.push({ level: 'info', msg, fields }); },
      warn(msg, fields) { state.logs.push({ level: 'warn', msg, fields }); },
      error(msg, fields) { state.logs.push({ level: 'error', msg, fields }); },
    },
  };
}

function ctxWith(host: AgentHost): ToolContext {
  return {
    creds: { apiKey: 'rdb_test', endpoint: 'http://localhost:8080/graphql' },
    host,
    role: 'read',
  };
}

test('runAgent: drives a no-tool turn through a mock AgentHost', async () => {
  _resetDefaultModelCache();
  const state: MockHostState = {
    fetches: [],
    chats: [],
    fetchResponses: [],
    chatResponses: [
      {
        id: 'cc_1',
        model: 'fdn/sonnet',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'hello' },
          finish_reason: 'stop',
        }],
      },
    ],
    logs: [],
  };
  const host = newMockHost(state);
  const result = await runAgent({
    systemPrompt: 'sys',
    userPrompt: 'hi',
    ctx: ctxWith(host),
    model: 'fdn/sonnet',
  });

  assert.equal(result.content, 'hello');
  assert.equal(result.iterations, 1);
  assert.equal(result.toolCallsTotal, 0);
  assert.equal(state.chats.length, 1, 'one chat completion');
  assert.equal(state.fetches.length, 0, 'no fetches when model is pinned');
  assert.equal(state.chats[0]!.req.model, 'fdn/sonnet');
  assert.equal(state.chats[0]!.req.messages.length, 2);
  assert.equal(state.chats[0]!.req.messages[0]!.role, 'system');
  assert.equal(state.chats[0]!.req.messages[1]!.role, 'user');
});

test('runAgent: resolves default chat model via host.fetch when model unset', async () => {
  _resetDefaultModelCache();
  const state: MockHostState = {
    fetches: [],
    chats: [],
    fetchResponses: [
      // llmRegistry response
      {
        status: 200,
        body: JSON.stringify({
          data: {
            llmRegistry: {
              defaults: [{ capability: 'chat', modelId: 'mock/chatmodel' }],
            },
          },
        }),
      },
    ],
    chatResponses: [
      {
        id: 'cc_2',
        model: 'mock/chatmodel',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'done' },
          finish_reason: 'stop',
        }],
      },
    ],
    logs: [],
  };
  const host = newMockHost(state);
  const result = await runAgent({
    systemPrompt: 'sys',
    userPrompt: 'hi',
    ctx: ctxWith(host),
    // model deliberately unset -- forces resolveDefaultChatModel
  });

  assert.equal(result.content, 'done');
  assert.equal(state.fetches.length, 1, 'one fetch for llmRegistry');
  assert.equal(state.fetches[0]!.url, 'http://localhost:8080/graphql');
  assert.equal(state.chats.length, 1);
  assert.equal(state.chats[0]!.req.model, 'mock/chatmodel');
});

test('runAgent: tool-call turn through mock host', async () => {
  _resetDefaultModelCache();
  const toolCalls: Array<{ name: string; args: unknown }> = [];
  const fakeTool: RegisteredTool = {
    name: 'fake_echo',
    description: 'returns args verbatim',
    minRole: 'read',
    parameters: { type: 'object' },
    async execute(_ctx, args) {
      toolCalls.push({ name: 'fake_echo', args });
      return { echoed: args };
    },
  };
  const state: MockHostState = {
    fetches: [],
    chats: [],
    fetchResponses: [],
    chatResponses: [
      // Turn 1: model emits a tool call.
      {
        id: 'cc_a',
        model: 'fdn/sonnet',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'tc_1',
              type: 'function',
              function: { name: 'fake_echo', arguments: '{"x":42}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
      // Turn 2: model accepts the tool result, emits final content.
      {
        id: 'cc_b',
        model: 'fdn/sonnet',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'all done' },
          finish_reason: 'stop',
        }],
      },
    ],
    logs: [],
  };
  const host = newMockHost(state);
  const result = await runAgent({
    systemPrompt: 'sys',
    userPrompt: 'echo 42',
    ctx: ctxWith(host),
    model: 'fdn/sonnet',
    tools: [fakeTool],
  });

  assert.equal(result.content, 'all done');
  assert.equal(result.iterations, 2);
  assert.equal(result.toolCallsTotal, 1);
  assert.deepEqual(toolCalls, [{ name: 'fake_echo', args: { x: 42 } }]);

  // The tool result message must be appended to history before the
  // second chat completion.
  assert.equal(state.chats.length, 2);
  const turn2Messages = state.chats[1]!.req.messages;
  // [system, user, assistant(tool_calls), tool(result)]
  assert.equal(turn2Messages.length, 4);
  assert.equal(turn2Messages[2]!.role, 'assistant');
  assert.equal(turn2Messages[3]!.role, 'tool');
});

test('runAgent: surfaces tool errors and continues', async () => {
  _resetDefaultModelCache();
  const explodingTool: RegisteredTool = {
    name: 'boom',
    description: 'throws',
    minRole: 'read',
    parameters: { type: 'object' },
    async execute() { throw new Error('kaboom'); },
  };
  const state: MockHostState = {
    fetches: [],
    chats: [],
    fetchResponses: [],
    chatResponses: [
      {
        id: 'cc_x',
        model: 'fdn/sonnet',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'tc_x',
              type: 'function',
              function: { name: 'boom', arguments: '{}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
      {
        id: 'cc_y',
        model: 'fdn/sonnet',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'gave up' },
          finish_reason: 'stop',
        }],
      },
    ],
    logs: [],
  };
  const host = newMockHost(state);
  const result = await runAgent({
    systemPrompt: 'sys',
    userPrompt: 'try it',
    ctx: ctxWith(host),
    model: 'fdn/sonnet',
    tools: [explodingTool],
  });

  assert.equal(result.content, 'gave up');
  assert.equal(result.toolEvents.length, 1);
  assert.equal(result.toolEvents[0]!.ok, false);
  assert.deepEqual(result.toolEvents[0]!.result, { error: 'kaboom' });

  // Turn 2 must include the tool error in the message history.
  const turn2Messages = state.chats[1]!.req.messages;
  const lastMsg = turn2Messages[turn2Messages.length - 1]!;
  assert.equal(lastMsg.role, 'tool');
  assert.ok((lastMsg as { content: string }).content.includes('kaboom'));
});
