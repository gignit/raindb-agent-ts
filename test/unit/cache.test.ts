// cache.test.ts -- cache_stats_my tool tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cache_stats_my } from '../../src/tools/cache.js';
import type { ToolContext } from '../../src/registry/types.js';

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

function ctx(): ToolContext {
  return {
    creds: {
      apiKey: 'rdb_test',
      endpoint: 'http://localhost:8080/graphql',
    },
    role: 'read',
  };
}

test('cache_stats_my: emits MyCacheStats query + projects result', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        myCacheStats: {
          tenantId: 'tenant-test',
          maxBytes: 1_000_000,
          currentBytes: 500_000,
          itemCount: 42,
          hitCount: 100,
          missCount: 5,
          hitRatio: 0.952,
          evictionCount: 0,
          bytesReadFromS3: 250_000,
          bytesEvicted: 0,
          avgItemSize: 11_904.7,
          lastUpdated: 1_700_000_000_000,
          hosts: [],
        },
      },
    },
    recorder,
  );

  try {
    const result = await cache_stats_my.execute(ctx(), {});
    assert.equal(recorder.length, 1);
    assert.match(recorder[0]!.body.query, /myCacheStats/);
    const r = result as { tenantId: string; itemCount: number; hitRatio: number };
    assert.equal(r.tenantId, 'tenant-test');
    assert.equal(r.itemCount, 42);
    assert.equal(r.hitRatio, 0.952);
  } finally {
    globalThis.fetch = original;
  }
});

test('cache_stats_my: returns zero-valued row when myCacheStats is null', async () => {
  // Mirrors Go behavior: ops/cache.go::GetMyCacheStats returns an
  // empty CacheStatsRow when the response is nil. The TS port
  // mirrors this so callers get a stable shape.
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: { myCacheStats: null } }, recorder);

  try {
    const result = await cache_stats_my.execute(ctx(), {});
    const r = result as { tenantId: string; itemCount: number };
    assert.equal(r.tenantId, '');
    assert.equal(r.itemCount, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('cache_stats_my: tool metadata matches Go reference', () => {
  assert.equal(cache_stats_my.name, 'cache_stats_my');
  assert.equal(cache_stats_my.minRole, 'read');
  assert.ok(!cache_stats_my.modifiesResource);
  assert.equal(cache_stats_my.parameters.type, 'object');
  // No required params on cache_stats_my -- the Go side has Schema:
  // &llm.ToolParameters{Type: "object"} with no Properties or
  // Required.
  assert.ok(!cache_stats_my.parameters.required || cache_stats_my.parameters.required.length === 0);
});
