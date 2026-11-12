// pack_list.test.ts -- unit test for the pack_list marketplace tool.
//
// pack_list fetches from the RainDB marketplace REST endpoint
// (/api/marketplace/packs), not the GraphQL API. The marketplace is
// an anonymous-readable REST surface, so the package does not reach
// into marketplace droplets through per-tenant credentials.
//
// We mock global fetch and verify:
//   1. The tool hits ${marketplaceBaseUrl}/api/marketplace/packs
//   2. Filter args (vendor, category, usageIntent, search) flow
//      through as query-string params; the server is the canonical
//      filter implementation.
//   3. The response envelope ({tagline, packs}) is projected to
//      the packs array.
//   4. Missing marketplaceBaseUrl returns an explicit error per the
//      "no fallbacks" principle.
//
// Mirrors wire shape verified empirically via:
//   curl -s 'http://localhost:4000/api/marketplace/packs?search=guide'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pack_list } from '../../src/tools/marketplace.js';
import type { ToolContext } from '../../src/registry/types.js';
import { makeNodeHost } from '../../src/host/node.js';

interface FetchCallRecord {
  url: string;
  method?: string;
  headers: Record<string, string>;
}

function mockFetch(
  responseBody: unknown,
  recorder: FetchCallRecord[],
  status = 200,
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const headers = (init?.headers as Record<string, string>) ?? {};
    recorder.push({ url, method: init?.method, headers });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function ctx(): ToolContext {
  return {
    creds: { apiKey: 'rdb_test', endpoint: 'http://localhost:8080/graphql' },
    host: makeNodeHost({ apiKey: 'rdb_test', endpoint: 'http://localhost:8080/graphql' }),
    role: 'read',
    marketplaceBaseUrl: 'http://localhost:4000',
  };
}

test('pack_list: GET /api/marketplace/packs with no filters', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      tagline: 'RainDB Marketplace',
      packs: [
        {
          packId: 'p1',
          vendor: 'raindb',
          packName: 'social',
          version: '1.0.0',
          vendorPackKey: 'raindb-social',
          title: 'Social Patterns',
          category: 'social',
          usageIntent: 'example',
          publishedAt: '2026-01-02T00:00:00Z',
          totalFiles: 29,
          tags: ['social'],
        },
        {
          packId: 'p2',
          vendor: 'raindb',
          packName: 'finance',
          version: '1.0.0',
          vendorPackKey: 'raindb-finance',
          title: 'Finance Patterns',
          category: 'finance',
          usageIntent: 'example',
          publishedAt: '2026-01-02T00:00:00Z',
          totalFiles: 12,
          tags: ['finance'],
        },
      ],
    },
    recorder,
  );

  try {
    const result = await pack_list.execute(ctx(), {});
    assert.equal(recorder.length, 1);
    assert.equal(recorder[0]!.url, 'http://localhost:4000/api/marketplace/packs');
    assert.equal(recorder[0]!.method ?? 'GET', 'GET');
    const arr = result as Array<{ packId: string }>;
    assert.equal(arr.length, 2);
    assert.equal(arr[0]!.packId, 'p1');
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_list: filters flow through as query-string params', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    { tagline: '', packs: [] },
    recorder,
  );

  try {
    await pack_list.execute(ctx(), {
      vendor: 'raindb',
      category: 'social',
      usageIntent: 'example',
      search: 'patterns',
    });
    // URLSearchParams orders the keys in insertion order. We don't
    // rely on the exact order across versions, just on presence.
    const u = new URL(recorder[0]!.url);
    assert.equal(u.pathname, '/api/marketplace/packs');
    assert.equal(u.searchParams.get('vendor'), 'raindb');
    assert.equal(u.searchParams.get('category'), 'social');
    assert.equal(u.searchParams.get('usageIntent'), 'example');
    assert.equal(u.searchParams.get('search'), 'patterns');
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_list: empty filters produce no query string', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ tagline: '', packs: [] }, recorder);

  try {
    await pack_list.execute(ctx(), {
      vendor: '',
      category: '',
      search: '',
    });
    // No query string -- empty-string filters are dropped.
    assert.equal(recorder[0]!.url, 'http://localhost:4000/api/marketplace/packs');
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_list: empty response envelope returns []', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ tagline: '' }, recorder); // no packs field

  try {
    const result = await pack_list.execute(ctx(), {});
    assert.deepEqual(result, []);
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_list: missing marketplaceBaseUrl returns explicit error (no fallback)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ tagline: '', packs: [] }, recorder);

  try {
    const noMarketCtx: ToolContext = {
      creds: { apiKey: 'rdb_test', endpoint: 'http://localhost:8080/graphql' },
      host: makeNodeHost({ apiKey: 'rdb_test', endpoint: 'http://localhost:8080/graphql' }),
      role: 'read',
      // marketplaceBaseUrl deliberately omitted
    };
    const result = await pack_list.execute(noMarketCtx, {});
    assert.ok(result && typeof result === 'object' && 'error' in result);
    assert.match((result as { error: string }).error, /marketplaceBaseUrl required/);
    assert.equal(recorder.length, 0, 'no fetch call when context invalid');
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_list: trailing slash on marketplaceBaseUrl is stripped', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ tagline: '', packs: [] }, recorder);

  try {
    const ctxWithSlash: ToolContext = {
      creds: { apiKey: 'rdb_test', endpoint: 'http://localhost:8080/graphql' },
      host: makeNodeHost({ apiKey: 'rdb_test', endpoint: 'http://localhost:8080/graphql' }),
      role: 'read',
      marketplaceBaseUrl: 'http://localhost:4000///',
    };
    await pack_list.execute(ctxWithSlash, {});
    assert.equal(recorder[0]!.url, 'http://localhost:4000/api/marketplace/packs');
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_list: HTTP error from marketplace surfaces as RaindbError', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ error: 'internal' }, recorder, 500);

  try {
    await assert.rejects(
      pack_list.execute(ctx(), {}),
      /marketplace fetch failed \(HTTP 500\)/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_list: tool metadata matches marketplace surface', () => {
  assert.equal(pack_list.name, 'pack_list');
  assert.equal(pack_list.minRole, 'read');
  assert.ok(!pack_list.modifiesResource);
  assert.equal(pack_list.parameters.type, 'object');
  // No required filter params -- pack_list with no args returns the full
  // (server-filter-default) catalog.
  assert.ok(!pack_list.parameters.required || pack_list.parameters.required.length === 0);
});
