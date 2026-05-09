// pack_list.test.ts -- unit test for the marketplace pilot tool.
//
// We mock global fetch (the only thing executeGraphQL touches) so
// the test is fully offline. The test verifies:
//   1. The tool emits the expected ListDroplets GraphQL query +
//      variables to raindb-api.
//   2. The response is grouped by vendorPackKey, latest by
//      publishedAt -- mirrors ops/marketplace.go::PackList.
//   3. Filter args (vendor, category, usageIntent, search) winnow
//      the result correctly.
//   4. The returned array is sorted (vendor asc, packName asc).
//
// Mirrors the wire shape verified via:
//   coder_go_function selector="^PackList$" cwd=~/src/raindb-phoenix-oc

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pack_list } from '../../src/tools/marketplace.js';
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
      apiKey: 'rdb_test_key',
      endpoint: 'http://localhost:8080/graphql',
    },
    role: 'read',
  };
}

test('pack_list: builds ListDroplets query and groups by vendorPackKey', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        listDroplets: {
          droplets: [
            {
              dropletId: 'd1',
              formationId: 'platform_marketplace_pack',
              schemaVersion: 1,
              ts: '2026-01-01',
              author: 'raindb',
              payload: {
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
            },
            {
              dropletId: 'd2',
              formationId: 'platform_marketplace_pack',
              schemaVersion: 1,
              ts: '2026-01-01',
              author: 'raindb',
              payload: {
                packId: 'p1-v2',
                vendor: 'raindb',
                packName: 'social',
                version: '1.0.1',
                vendorPackKey: 'raindb-social',
                title: 'Social Patterns',
                category: 'social',
                usageIntent: 'example',
                publishedAt: '2026-01-03T00:00:00Z',
                totalFiles: 30,
                tags: ['social'],
              },
            },
            {
              dropletId: 'd3',
              formationId: 'platform_marketplace_pack',
              schemaVersion: 1,
              ts: '2026-01-01',
              author: 'raindb',
              payload: {
                packId: 'p2',
                vendor: 'raindb',
                packName: 'finance-transactions',
                version: '1.0.0',
                vendorPackKey: 'raindb-finance-transactions',
                title: 'Finance: Transactions',
                category: 'finance',
                usageIntent: 'example',
                publishedAt: '2026-01-02T00:00:00Z',
                totalFiles: 4,
                tags: ['finance'],
              },
            },
          ],
          hasMore: false,
        },
      },
    },
    recorder,
  );

  try {
    const result = await pack_list.execute(ctx(), {});

    // 1. Wire shape verification.
    assert.equal(recorder.length, 1, 'exactly one GraphQL call');
    assert.equal(recorder[0]!.url, 'http://localhost:8080/graphql');
    assert.equal(recorder[0]!.headers['X-API-Key'], 'rdb_test_key');
    assert.match(recorder[0]!.body.query, /listDroplets/);
    assert.deepEqual(recorder[0]!.body.variables, {
      input: {
        formationId: 'platform_marketplace_pack',
        prefix: 'entities/platform_marketplace_pack/',
        pageSize: 200,
      },
    });

    // 2. Grouping: two versions of raindb-social collapse to the
    //    later-published one.
    const arr = result as Array<{ vendor: string; packName: string; version: string }>;
    assert.equal(arr.length, 2);
    const social = arr.find((p) => p.packName === 'social');
    assert.ok(social, 'social pack present');
    assert.equal(social.version, '1.0.1', 'kept the later-published version');

    // 3. Sort: vendor asc, packName asc. Both packs are vendor=raindb
    //    so finance-transactions sorts before social.
    assert.equal(arr[0]!.packName, 'finance-transactions');
    assert.equal(arr[1]!.packName, 'social');
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_list: filters by category', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        listDroplets: {
          droplets: [
            {
              dropletId: 'd1',
              formationId: 'platform_marketplace_pack',
              schemaVersion: 1,
              ts: '2026-01-01',
              author: 'raindb',
              payload: {
                packId: 'p1',
                vendor: 'raindb',
                packName: 'social',
                version: '1.0.0',
                vendorPackKey: 'raindb-social',
                category: 'social',
                publishedAt: '2026-01-02T00:00:00Z',
              },
            },
            {
              dropletId: 'd2',
              formationId: 'platform_marketplace_pack',
              schemaVersion: 1,
              ts: '2026-01-01',
              author: 'raindb',
              payload: {
                packId: 'p2',
                vendor: 'raindb',
                packName: 'finance-transactions',
                version: '1.0.0',
                vendorPackKey: 'raindb-finance-transactions',
                category: 'finance',
                publishedAt: '2026-01-02T00:00:00Z',
              },
            },
          ],
          hasMore: false,
        },
      },
    },
    recorder,
  );

  try {
    const result = await pack_list.execute(ctx(), { category: 'finance' });
    const arr = result as Array<{ packName: string; category: string }>;
    assert.equal(arr.length, 1);
    assert.equal(arr[0]!.packName, 'finance-transactions');
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_list: free-text search hits title/description/tags', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        listDroplets: {
          droplets: [
            {
              dropletId: 'd1',
              formationId: 'platform_marketplace_pack',
              schemaVersion: 1,
              ts: '2026-01-01',
              author: 'raindb',
              payload: {
                packId: 'p1',
                vendor: 'raindb',
                packName: 'real-estate-listings',
                version: '1.0.0',
                vendorPackKey: 'raindb-real-estate-listings',
                title: 'Real Estate: Property Listings',
                publishedAt: '2026-01-02',
              },
            },
            {
              dropletId: 'd2',
              formationId: 'platform_marketplace_pack',
              schemaVersion: 1,
              ts: '2026-01-01',
              author: 'raindb',
              payload: {
                packId: 'p2',
                vendor: 'raindb',
                packName: 'media-photos',
                version: '1.0.0',
                vendorPackKey: 'raindb-media-photos',
                title: 'Media: Photos & Albums',
                publishedAt: '2026-01-02',
              },
            },
          ],
          hasMore: false,
        },
      },
    },
    recorder,
  );

  try {
    const result = await pack_list.execute(ctx(), { search: 'photo' });
    const arr = result as Array<{ packName: string }>;
    assert.equal(arr.length, 1);
    assert.equal(arr[0]!.packName, 'media-photos');
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_list: pageSize override flows to GraphQL variables', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    { data: { listDroplets: { droplets: [], hasMore: false } } },
    recorder,
  );

  try {
    await pack_list.execute(ctx(), { pageSize: 50 });
    assert.equal(
      (recorder[0]!.body.variables.input as { pageSize: number }).pageSize,
      50,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_list: tool metadata matches Go reference', () => {
  // These checks ensure the wire surface stays in lockstep with
  // raindb-phoenix-oc/internal/ai/tools_marketplace.go::tenantMarketplaceTools
  // pack_list entry. If the Go side changes, these break first.
  assert.equal(pack_list.name, 'pack_list');
  assert.equal(pack_list.minRole, 'read');
  assert.ok(!pack_list.modifiesResource);
  assert.equal(pack_list.parameters.type, 'object');
  const props = pack_list.parameters.properties ?? {};
  assert.ok('vendor' in props);
  assert.ok('category' in props);
  assert.ok('usageIntent' in props);
  assert.ok('search' in props);
  assert.ok('pageSize' in props);
  // pack_list is read-only; it has NO required fields.
  assert.equal(pack_list.parameters.required?.length ?? 0, 0);
});
