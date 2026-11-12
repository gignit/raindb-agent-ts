// key.test.ts -- API-key management tools.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  key_list,
  key_create,
  key_revoke,
} from '../../src/tools/key.js';
import type { ToolContext } from '../../src/registry/types.js';
import { makeNodeHost } from '../../src/host/node.js';

interface FetchCallRecord {
  body: { query: string; variables: Record<string, unknown> };
}

function mockFetch(
  responseBody: unknown,
  recorder: FetchCallRecord[],
): typeof fetch {
  return async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    recorder.push({ body });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function ctx(role: 'read' | 'write' | 'admin' = 'admin'): ToolContext {
  return {
    creds: {
      apiKey: 'rdb_test',
      endpoint: 'http://localhost:8080/graphql',
    },
    host: makeNodeHost({ apiKey: 'rdb_test', endpoint: 'http://localhost:8080/graphql' }),
    role,
  };
}

test('key_list: emits ListAPIKeys query, default pageSize 100', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        listAPIKeys: {
          keys: [
            {
              apiClientId: 'c1',
              tenantId: 't1',
              scopes: ['read'],
              createdAt: '2026-01-01',
            },
          ],
          hasMore: false,
          totalCount: 1,
        },
      },
    },
    recorder,
  );

  try {
    const r = await key_list.execute(ctx('read'), {});
    assert.match(recorder[0]!.body.query, /listAPIKeys/);
    assert.equal(recorder[0]!.body.variables['pageSize'], 100);
    const page = r as { keys: Array<{ apiClientId: string }>; totalCount: number };
    assert.equal(page.totalCount, 1);
    assert.equal(page.keys[0]!.apiClientId, 'c1');
  } finally {
    globalThis.fetch = original;
  }
});

test('key_create: emits CreateAPIKey with scopes', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        createAPIKey: {
          apiClientId: 'c1',
          apiKey: 'rdb_secret_value',
          info: {
            apiClientId: 'c1',
            tenantId: 't1',
            scopes: ['read', 'write'],
            createdAt: '2026-01-01',
          },
        },
      },
    },
    recorder,
  );

  try {
    const r = await key_create.execute(ctx(), {
      scopes: ['read', 'write'],
      expiresAt: '2027-01-01T00:00:00Z',
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.deepEqual(input['scopes'], ['read', 'write']);
    assert.equal(input['expiresAt'], '2027-01-01T00:00:00Z');
    const result = r as { apiKey: string; apiClientId: string };
    assert.equal(result.apiKey, 'rdb_secret_value');
    assert.equal(result.apiClientId, 'c1');
  } finally {
    globalThis.fetch = original;
  }
});

test('key_create: empty scopes returns error', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: {} }, recorder);

  try {
    const r = await key_create.execute(ctx(), { scopes: [] });
    assert.deepEqual(r, { error: 'scopes required' });
    assert.equal(recorder.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('key_revoke: emits RevokeAPIKey mutation', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        revokeAPIKey: {
          apiClientId: 'c1',
          revokedAt: '2026-05-09T00:00:00Z',
        },
      },
    },
    recorder,
  );

  try {
    const r = await key_revoke.execute(ctx(), { apiClientId: 'c1' });
    assert.equal(recorder[0]!.body.variables['apiClientId'], 'c1');
    const result = r as { apiClientId: string; revokedAt: string };
    assert.equal(result.apiClientId, 'c1');
  } finally {
    globalThis.fetch = original;
  }
});

test('key tools: metadata matches the tenant tool spec', () => {
  assert.equal(key_list.minRole, 'read');
  assert.ok(!key_list.modifiesResource);

  assert.equal(key_create.minRole, 'admin');
  assert.equal(key_create.modifiesResource, true);
  assert.deepEqual(key_create.parameters.required, ['scopes']);

  assert.equal(key_revoke.minRole, 'admin');
  assert.equal(key_revoke.modifiesResource, true);
  assert.deepEqual(key_revoke.parameters.required, ['apiClientId']);
});
