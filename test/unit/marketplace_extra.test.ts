// marketplace_extra.test.ts -- pack_info, pack_get, pack_features,
// vendor_list, vendor_info tool tests. (pack_list is in
// pack_list.test.ts since it shipped in M1.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  pack_info,
  pack_get,
  pack_features,
  vendor_list,
  vendor_info,
} from '../../src/tools/marketplace.js';
import type { ToolContext } from '../../src/registry/types.js';

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
    role: 'read',
  };
}

const FULL_PACK_PAYLOAD = {
  packId: '019e0e57-1cff-7c90-afb7-46b33759826a',
  vendor: 'raindb',
  packName: 'social',
  version: '1.0.0',
  vendorPackKey: 'raindb-social',
  vendorPackVersion: 'raindb-social-1.0.0',
  packGroup: 'patterns',
  title: 'Social Patterns',
  displayName: 'Social Patterns',
  description: 'Posts, follows, feeds, comments.',
  category: 'social',
  subcategory: '',
  tags: ['social', 'patterns'],
  icon: '',
  license: 'MIT',
  deprecated: false,
  usageIntent: 'example',
  totalFiles: 29,
  totalLoc: 4200,
  tokenEstimate: 12_000,
  publishedAt: '2026-05-09T20:04:10Z',
  updatedAt: '',
  triggerPatterns: [],
  dependencySignals: [],
  readme: '# Social Patterns\n\n...',
  features: [
    { id: 'core', displayName: 'Core', description: 'Posts + users.', default: true, requires: [] },
    { id: 'messaging', displayName: 'Messaging', description: 'DMs.', default: false, requires: ['core'] },
  ],
  files: [
    { path: 'formations/post/config.json', kind: 'formation-config', feature: 'core' },
  ],
  sourceHash: 'abc123',
};

// ---------------------------------------------------------------------------
// pack_info
// ---------------------------------------------------------------------------

test('pack_info: latest -> by-vendor-pack-latest index', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        readLatest: {
          dropletId: 'd1',
          formationId: 'platform_marketplace_pack',
          ts: '2026-05-09',
          payload: FULL_PACK_PAYLOAD,
        },
      },
    },
    recorder,
  );

  try {
    const result = await pack_info.execute(ctx(), {
      vendor: 'raindb',
      packName: 'social',
    });
    assert.match(recorder[0]!.body.query, /readLatest/);
    const input = recorder[0]!.body.variables['input'] as Record<string, string>;
    assert.equal(input['formationId'], 'platform_marketplace_pack');
    assert.equal(input['indexId'], 'by-vendor-pack-latest');
    assert.equal(input['scopeValue'], 'raindb-social');
    const r = result as { packId: string; features: Array<{ id: string }> };
    assert.equal(r.packId, '019e0e57-1cff-7c90-afb7-46b33759826a');
    assert.equal(r.features.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_info: pinned version -> by-vendor-pack-version index', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        readLatest: {
          dropletId: 'd1',
          formationId: 'platform_marketplace_pack',
          ts: '2026-05-09',
          payload: FULL_PACK_PAYLOAD,
        },
      },
    },
    recorder,
  );

  try {
    await pack_info.execute(ctx(), {
      vendor: 'raindb',
      packName: 'social',
      version: '1.0.0',
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, string>;
    assert.equal(input['indexId'], 'by-vendor-pack-version');
    assert.equal(input['scopeValue'], 'raindb-social-1.0.0');
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_info: missing required args returns error', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: {} }, recorder);

  try {
    const r = await pack_info.execute(ctx(), { vendor: 'raindb' });
    assert.deepEqual(r, { error: 'vendor and packName required' });
    assert.equal(recorder.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_info: 404 surfaces as error string', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: { readLatest: null } }, recorder);

  try {
    const r = await pack_info.execute(ctx(), {
      vendor: 'unknown',
      packName: 'pack',
    });
    assert.deepEqual(r, { error: 'pack not found: unknown/pack' });
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// pack_get
// ---------------------------------------------------------------------------

test('pack_get: behaves identically to pack_info (alias)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        readLatest: {
          dropletId: 'd1',
          formationId: 'platform_marketplace_pack',
          ts: '2026-05-09',
          payload: FULL_PACK_PAYLOAD,
        },
      },
    },
    recorder,
  );

  try {
    const r = await pack_get.execute(ctx(), {
      vendor: 'raindb',
      packName: 'social',
    });
    const p = r as { vendor: string; packName: string };
    assert.equal(p.vendor, 'raindb');
    assert.equal(p.packName, 'social');
    // Same execute reference so same wire shape.
    assert.equal(pack_get.execute, pack_info.execute);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// pack_features
// ---------------------------------------------------------------------------

test('pack_features: projects pack_info result to features array', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        readLatest: {
          dropletId: 'd1',
          formationId: 'platform_marketplace_pack',
          ts: '2026-05-09',
          payload: FULL_PACK_PAYLOAD,
        },
      },
    },
    recorder,
  );

  try {
    const r = await pack_features.execute(ctx(), {
      vendor: 'raindb',
      packName: 'social',
    });
    const features = r as Array<{ id: string; default: boolean }>;
    assert.equal(features.length, 2);
    assert.equal(features[0]!.id, 'core');
    assert.equal(features[0]!.default, true);
    assert.equal(features[1]!.id, 'messaging');
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_features: surfaces pack_info errors verbatim', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: { readLatest: null } }, recorder);

  try {
    const r = await pack_features.execute(ctx(), {
      vendor: 'unknown',
      packName: 'pack',
    });
    assert.ok('error' in (r as Record<string, unknown>));
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// vendor_list
// ---------------------------------------------------------------------------

test('vendor_list: dedupes by vendorId + sorts asc', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        listDroplets: {
          droplets: [
            {
              dropletId: 'd2',
              formationId: 'platform_marketplace_vendor',
              schemaVersion: 1,
              ts: '2026-01-01',
              author: 'platform',
              payload: { vendorId: 'stripe', displayName: 'Stripe', verified: true },
            },
            {
              dropletId: 'd1',
              formationId: 'platform_marketplace_vendor',
              schemaVersion: 1,
              ts: '2026-01-01',
              author: 'platform',
              payload: { vendorId: 'raindb', displayName: 'RainDB', verified: true },
            },
            // duplicate vendorId -- should be deduped
            {
              dropletId: 'd1b',
              formationId: 'platform_marketplace_vendor',
              schemaVersion: 1,
              ts: '2026-01-02',
              author: 'platform',
              payload: { vendorId: 'raindb', displayName: 'RainDB v2', verified: true },
            },
          ],
          hasMore: false,
        },
      },
    },
    recorder,
  );

  try {
    const r = await vendor_list.execute(ctx(), {});
    const arr = r as Array<{ vendorId: string }>;
    assert.equal(arr.length, 2, 'duplicate vendorId removed');
    assert.equal(arr[0]!.vendorId, 'raindb', 'sorted asc');
    assert.equal(arr[1]!.vendorId, 'stripe');
  } finally {
    globalThis.fetch = original;
  }
});

test('vendor_list: emits ListDroplets query against vendor formation', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    { data: { listDroplets: { droplets: [], hasMore: false } } },
    recorder,
  );

  try {
    await vendor_list.execute(ctx(), {});
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['formationId'], 'platform_marketplace_vendor');
    assert.equal(input['prefix'], 'entities/platform_marketplace_vendor/');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// vendor_info
// ---------------------------------------------------------------------------

test('vendor_info: emits readLatest with by-id-latest index', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        readLatest: {
          dropletId: 'd1',
          formationId: 'platform_marketplace_vendor',
          ts: '2026-01-01',
          payload: {
            vendorId: 'raindb',
            displayName: 'RainDB',
            description: 'Platform vendor',
            verified: true,
            license: 'MIT',
          },
        },
      },
    },
    recorder,
  );

  try {
    const r = await vendor_info.execute(ctx(), { vendorId: 'raindb' });
    const input = recorder[0]!.body.variables['input'] as Record<string, string>;
    assert.equal(input['formationId'], 'platform_marketplace_vendor');
    assert.equal(input['indexId'], 'by-id-latest');
    assert.equal(input['scopeValue'], 'raindb');
    const v = r as { vendorId: string; verified: boolean; license?: string };
    assert.equal(v.vendorId, 'raindb');
    assert.equal(v.verified, true);
    assert.equal(v.license, 'MIT');
  } finally {
    globalThis.fetch = original;
  }
});

test('vendor_info: missing vendorId returns error', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: {} }, recorder);

  try {
    const r = await vendor_info.execute(ctx(), {});
    assert.deepEqual(r, { error: 'vendorId required' });
    assert.equal(recorder.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('vendor_info: 404 surfaces as error string', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: { readLatest: null } }, recorder);

  try {
    const r = await vendor_info.execute(ctx(), { vendorId: 'unknown' });
    assert.deepEqual(r, { error: 'vendor not found: unknown' });
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// metadata parity
// ---------------------------------------------------------------------------

test('marketplace tools: metadata matches Go reference', () => {
  assert.equal(pack_info.name, 'pack_info');
  assert.equal(pack_info.minRole, 'read');
  assert.deepEqual(pack_info.parameters.required, ['vendor', 'packName']);

  assert.equal(pack_get.name, 'pack_get');
  assert.equal(pack_get.minRole, 'read');

  assert.equal(pack_features.name, 'pack_features');
  assert.equal(pack_features.minRole, 'read');
  assert.deepEqual(pack_features.parameters.required, ['vendor', 'packName']);

  assert.equal(vendor_list.name, 'vendor_list');
  assert.equal(vendor_list.minRole, 'read');
  assert.ok(!vendor_list.parameters.required || vendor_list.parameters.required.length === 0);

  assert.equal(vendor_info.name, 'vendor_info');
  assert.equal(vendor_info.minRole, 'read');
  assert.deepEqual(vendor_info.parameters.required, ['vendorId']);
});
