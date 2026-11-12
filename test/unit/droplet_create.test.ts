// droplet_create.test.ts -- unit test for the mutating pilot tool.
//
// Verifies:
//   1. The tool emits the expected WriteDroplet GraphQL mutation +
//      input shape (matches the WriteDropletInput wire contract).
//   2. ModifiesResource flag is set so the agent loop's confirm
//      gate fires.
//   3. Author resolution prefers ctx.userId, falls back to "agent".
//   4. Required-arg validation surfaces a friendly error.
//   5. triggerFlows defaults to true; explicit false flows through.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { droplet_create } from '../../src/tools/droplet.js';
import type { ToolContext } from '../../src/registry/types.js';
import { makeNodeHost } from '../../src/host/node.js';

interface FetchCallRecord {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
  headers: Record<string, string>;
}

function mockFetch(
  responseBody: unknown,
  recorder: FetchCallRecord[],
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const headers = (init?.headers as Record<string, string>) ?? {};
    recorder.push({ url, body, headers });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    creds: {
      apiKey: 'rdb_test_key',
      endpoint: 'http://localhost:8080/graphql',
    },
    host: makeNodeHost({ apiKey: 'rdb_test', endpoint: 'http://localhost:8080/graphql' }),
    role: 'write',
    ...overrides,
  };
}

const SUCCESS_RESPONSE = {
  data: {
    writeDroplet: {
      dropletId: '01970000-0000-0000-0000-000000000000',
      pathsWritten: ['tenants/abc/entities/widget/x/2026/01/01/d.json'],
      floatPaths: [],
      publicUrls: [],
      vectorRefs: [],
      warnings: [],
      scopeValue: 'x',
      pointerETag: null,
      durationMs: 12,
    },
  },
};

test('droplet_create: writes payload via WriteDroplet mutation', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(SUCCESS_RESPONSE, recorder);

  try {
    const result = await droplet_create.execute(
      ctx({ userId: 'user-bob' }),
      {
        formation: 'widget',
        payload: { x: 'one', y: 2 },
      },
    );

    assert.equal(recorder.length, 1);
    assert.match(recorder[0]!.body.query, /WriteDroplet/);
    const input = (recorder[0]!.body.variables as { input: Record<string, unknown> }).input;
    assert.equal(input.formationId, 'widget');
    assert.deepEqual(input.payload, { x: 'one', y: 2 });
    assert.equal(input.author, 'user-bob');
    assert.equal(input.triggerFlows, true);

    const r = result as { dropletId: string };
    assert.equal(r.dropletId, '01970000-0000-0000-0000-000000000000');
  } finally {
    globalThis.fetch = original;
  }
});

test('droplet_create: author falls back to "agent" when ctx.userId is missing', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(SUCCESS_RESPONSE, recorder);

  try {
    await droplet_create.execute(ctx(), {
      formation: 'widget',
      payload: { x: 'one' },
    });
    const input = (recorder[0]!.body.variables as { input: Record<string, unknown> }).input;
    assert.equal(input.author, 'agent');
  } finally {
    globalThis.fetch = original;
  }
});

test('droplet_create: triggerFlows=false flows through', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(SUCCESS_RESPONSE, recorder);

  try {
    await droplet_create.execute(ctx(), {
      formation: 'widget',
      payload: { x: 'one' },
      triggerFlows: false,
    });
    const input = (recorder[0]!.body.variables as { input: Record<string, unknown> }).input;
    assert.equal(input.triggerFlows, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('droplet_create: missing formation returns a friendly error (no GraphQL call)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(SUCCESS_RESPONSE, recorder);

  try {
    const result = await droplet_create.execute(ctx(), {
      payload: { x: 'one' },
    });
    assert.deepEqual(result, { error: 'formation is required' });
    assert.equal(recorder.length, 0, 'no GraphQL call when validation fails');
  } finally {
    globalThis.fetch = original;
  }
});

test('droplet_create: missing payload returns a friendly error (no GraphQL call)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(SUCCESS_RESPONSE, recorder);

  try {
    const result = await droplet_create.execute(ctx(), {
      formation: 'widget',
    });
    assert.deepEqual(result, { error: 'payload (object) is required' });
    assert.equal(recorder.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('droplet_create: tool metadata matches the tenant tool spec', () => {
  assert.equal(droplet_create.name, 'droplet_create');
  assert.equal(droplet_create.minRole, 'write');
  assert.equal(droplet_create.modifiesResource, true);
  assert.equal(droplet_create.parameters.type, 'object');
  const props = droplet_create.parameters.properties ?? {};
  assert.ok('formation' in props);
  assert.ok('payload' in props);
  assert.ok('triggerFlows' in props);
  assert.deepEqual(droplet_create.parameters.required, ['formation', 'payload']);
});
