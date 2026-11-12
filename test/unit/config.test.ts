// config.test.ts -- config_get tool tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { config_get } from '../../src/tools/config.js';
import type { ToolContext } from '../../src/registry/types.js';
import { makeNodeHost } from '../../src/host/node.js';

interface FetchCallRecord {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
}

function mockFetch(
  responseBody: unknown,
  recorder: FetchCallRecord[],
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    recorder.push({ url, body });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function ctx(): ToolContext {
  return {
    creds: {
      apiKey: 'rdb_test',
      endpoint: 'http://localhost:8080/graphql',
    },
    host: makeNodeHost({ apiKey: 'rdb_test', endpoint: 'http://localhost:8080/graphql' }),
    role: 'read',
  };
}

test('config_get: emits ServiceConfig query with service variable', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        serviceConfig: {
          service: 'cyclone',
          s3Path: 's3://raindb-dev/cyclone/config.json',
          config: { workers: 4, maxConcurrency: 32 },
          etag: 'abc123',
          exists: true,
        },
      },
    },
    recorder,
  );

  try {
    const result = await config_get.execute(ctx(), { service: 'cyclone' });
    assert.equal(recorder.length, 1);
    assert.match(recorder[0]!.body.query, /serviceConfig/);
    assert.deepEqual(recorder[0]!.body.variables, { service: 'cyclone' });
    const r = result as { service: string; exists: boolean; config: Record<string, unknown> };
    assert.equal(r.service, 'cyclone');
    assert.equal(r.exists, true);
    assert.equal(r.config['workers'], 4);
  } finally {
    globalThis.fetch = original;
  }
});

test('config_get: missing service returns friendly error (no GraphQL call)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: {} }, recorder);

  try {
    const result = await config_get.execute(ctx(), {});
    assert.deepEqual(result, { error: 'service required' });
    assert.equal(recorder.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('config_get: surfaces server-side null as error', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: { serviceConfig: null } }, recorder);

  try {
    const result = await config_get.execute(ctx(), { service: 'unknown' });
    assert.deepEqual(result, { error: 'serviceConfig: nil response for unknown' });
  } finally {
    globalThis.fetch = original;
  }
});

test('config_get: tool metadata matches the tenant tool spec', () => {
  assert.equal(config_get.name, 'config_get');
  assert.equal(config_get.minRole, 'read');
  assert.ok(!config_get.modifiesResource);
  assert.deepEqual(config_get.parameters.required, ['service']);
  assert.ok(config_get.parameters.properties?.['service']);
});
