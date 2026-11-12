// loop.test.ts -- runAgent integration test with mocked
// openai-node + mocked fetch.
//
// We mock global fetch so both the openai HTTP calls and the
// llmRegistry GraphQL calls are intercepted. The fetch mock
// dispatches by URL substring -- requests to /v1/chat/completions
// emit a fake openai response; requests to /graphql emit a fake
// llmRegistry response.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAgent } from '../../src/loop/index.js';
import {
  _resetDefaultModelCache,
} from '../../src/client/raindbAi.js';
import type { RegisteredTool, ToolContext } from '../../src/registry/types.js';
import { makeNodeHost } from '../../src/host/node.js';

interface MockedCall {
  kind: 'graphql' | 'openai-chat' | 'unknown';
  body: Record<string, unknown>;
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    creds: {
      apiKey: 'rdb_test',
      endpoint: 'http://localhost:8080/graphql',
    },
    host: makeNodeHost({ apiKey: 'rdb_test', endpoint: 'http://localhost:8080/graphql' }),
    role: 'read',
    ...overrides,
  };
}

interface MockOptions {
  /** Sequential openai responses (one per chat completion call). */
  openAiResponses: Array<Record<string, unknown>>;
  /** llmRegistry response shared across calls. */
  llmRegistryResponse?: Record<string, unknown>;
  recorder: MockedCall[];
}

function setupMocks(opts: MockOptions): typeof fetch {
  let openAiIndex = 0;
  const llmReg = opts.llmRegistryResponse ?? {
    data: {
      llmRegistry: {
        defaults: [{ capability: 'chat', modelId: 'fdn/sonnet' }],
      },
    },
  };
  return async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith('/graphql')) {
      opts.recorder.push({ kind: 'graphql', body });
      return new Response(JSON.stringify(llmReg), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/v1/chat/completions')) {
      opts.recorder.push({ kind: 'openai-chat', body });
      const resp = opts.openAiResponses[openAiIndex];
      openAiIndex += 1;
      if (!resp) {
        return new Response('out of mock responses', { status: 500 });
      }
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    opts.recorder.push({ kind: 'unknown', body });
    return new Response('not mocked', { status: 500 });
  };
}

test('runAgent: returns final content when model emits no tool calls', async () => {
  _resetDefaultModelCache();
  const recorder: MockedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = setupMocks({
    openAiResponses: [
      {
        id: 'chatcmpl-test-1',
        object: 'chat.completion',
        created: Date.now() / 1000,
        model: 'fdn/sonnet',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'hello there!',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
    ],
    recorder,
  });

  try {
    const result = await runAgent({
      systemPrompt: 'You are a test assistant.',
      userPrompt: 'say hello',
      ctx: ctx(),
    });

    assert.equal(result.content, 'hello there!');
    assert.equal(result.iterations, 1);
    assert.equal(result.toolCallsTotal, 0);
    // One graphql call (llmRegistry) + one openai call.
    const openaiCalls = recorder.filter((r) => r.kind === 'openai-chat');
    assert.equal(openaiCalls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('runAgent: dispatches a tool call then returns final content', async () => {
  _resetDefaultModelCache();
  const recorder: MockedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = setupMocks({
    openAiResponses: [
      {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: Date.now() / 1000,
        model: 'fdn/sonnet',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'echo',
                    arguments: JSON.stringify({ msg: 'pong' }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      {
        id: 'chatcmpl-2',
        object: 'chat.completion',
        created: Date.now() / 1000,
        model: 'fdn/sonnet',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'tool said: pong',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
    ],
    recorder,
  });

  const echo: RegisteredTool = {
    name: 'echo',
    description: 'Echo a message back.',
    minRole: 'read',
    parameters: {
      type: 'object',
      properties: { msg: { type: 'string' } },
      required: ['msg'],
    },
    async execute(_ctx, args) {
      return { said: args.msg };
    },
  };

  try {
    const events: string[] = [];
    const result = await runAgent({
      systemPrompt: 'You are a test assistant.',
      userPrompt: 'invoke echo',
      ctx: ctx(),
      tools: [echo],
      onEvent: (e) => events.push(e.type),
    });

    assert.equal(result.iterations, 2);
    assert.equal(result.toolCallsTotal, 1);
    assert.equal(result.content, 'tool said: pong');
    assert.equal(result.toolEvents.length, 1);
    assert.equal(result.toolEvents[0]!.toolName, 'echo');
    assert.equal(result.toolEvents[0]!.ok, true);
    assert.deepEqual(result.toolEvents[0]!.result, { said: 'pong' });
    assert.ok(events.includes('thinking'));
    assert.ok(events.includes('tool-call'));
    assert.ok(events.includes('tool-result'));
    assert.ok(events.includes('final'));
  } finally {
    globalThis.fetch = original;
  }
});

test('runAgent: confirm denies a modifiesResource tool', async () => {
  _resetDefaultModelCache();
  const recorder: MockedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = setupMocks({
    openAiResponses: [
      {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: Date.now() / 1000,
        model: 'fdn/sonnet',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'destroy',
                    arguments: '{}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      {
        id: 'chatcmpl-2',
        object: 'chat.completion',
        created: Date.now() / 1000,
        model: 'fdn/sonnet',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'ok, I will not destroy.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
    ],
    recorder,
  });

  let executed = false;
  const destroy: RegisteredTool = {
    name: 'destroy',
    description: 'Destroy a resource.',
    minRole: 'admin',
    modifiesResource: true,
    parameters: { type: 'object' },
    async execute() {
      executed = true;
      return { ok: true };
    },
  };

  try {
    const result = await runAgent({
      systemPrompt: 'You are a test assistant.',
      userPrompt: 'destroy something',
      ctx: ctx({ role: 'admin' }),
      tools: [destroy],
      confirm: () => false,
    });

    assert.equal(executed, false, 'execute() must NOT run when confirm denies');
    assert.equal(result.toolEvents.length, 1);
    assert.equal(result.toolEvents[0]!.ok, false);
    assert.deepEqual(result.toolEvents[0]!.result, { error: 'tool call denied by user' });
  } finally {
    globalThis.fetch = original;
  }
});

function finalReply(content: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-model',
    object: 'chat.completion',
    created: Date.now() / 1000,
    model: 'echo',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
}

test('runAgent: an explicit model is sent as-is and the registry is never queried', async () => {
  _resetDefaultModelCache();
  const recorder: MockedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = setupMocks({ openAiResponses: [finalReply('ok')], recorder });
  try {
    await runAgent({
      systemPrompt: 's',
      userPrompt: 'u',
      ctx: ctx(),
      model: 'fdn-internal/sonnet-4.6',
    });
    assert.equal(recorder.filter((r) => r.kind === 'graphql').length, 0, 'no llmRegistry lookup');
    const chat = recorder.filter((r) => r.kind === 'openai-chat');
    assert.equal(chat.length, 1);
    assert.equal(chat[0]!.body['model'], 'fdn-internal/sonnet-4.6');
  } finally {
    globalThis.fetch = original;
  }
});

test('runAgent: without a model it sends the registry chat default', async () => {
  _resetDefaultModelCache();
  const recorder: MockedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = setupMocks({
    openAiResponses: [finalReply('ok')],
    llmRegistryResponse: {
      data: { llmRegistry: { defaults: [{ capability: 'chat', modelId: 'fdn-internal/nova-lite' }] } },
    },
    recorder,
  });
  try {
    await runAgent({ systemPrompt: 's', userPrompt: 'u', ctx: ctx() });
    const chat = recorder.filter((r) => r.kind === 'openai-chat');
    assert.equal(chat[0]!.body['model'], 'fdn-internal/nova-lite');
  } finally {
    globalThis.fetch = original;
  }
});
