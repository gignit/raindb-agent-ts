// marketplace_extra.test.ts -- pack_info, pack_get, pack_features,
// vendor_list, vendor_info tool tests. All marketplace tools fetch
// from the RainDB marketplace REST endpoint (/api/marketplace/*),
// not the GraphQL API.
//
// pack_list has its own test file (pack_list.test.ts).

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
import { makeNodeHost } from '../../src/host/node.js';

interface FetchCallRecord {
  url: string;
}

function mockFetch(
  responseBody: unknown,
  recorder: FetchCallRecord[],
  status = 200,
): typeof fetch {
  return async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    recorder.push({ url });
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

const FULL_PACK = {
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

test('pack_info: latest -> /api/marketplace/packs/<vendor>/<pack>', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ pack: FULL_PACK }, recorder);

  try {
    const r = await pack_info.execute(ctx(), {
      vendor: 'raindb',
      packName: 'social',
    });
    assert.equal(recorder.length, 1);
    assert.equal(
      recorder[0]!.url,
      'http://localhost:4000/api/marketplace/packs/raindb/social',
    );
    const p = r as { packId: string; features: Array<{ id: string }> };
    assert.equal(p.packId, FULL_PACK.packId);
    assert.equal(p.features.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_info: pinned version -> ?version=<v>', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ pack: FULL_PACK }, recorder);

  try {
    await pack_info.execute(ctx(), {
      vendor: 'raindb',
      packName: 'social',
      version: '1.0.0',
    });
    const u = new URL(recorder[0]!.url);
    assert.equal(u.pathname, '/api/marketplace/packs/raindb/social');
    assert.equal(u.searchParams.get('version'), '1.0.0');
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_info: missing required args returns error (no fetch)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({}, recorder);

  try {
    const r = await pack_info.execute(ctx(), { vendor: 'raindb' });
    assert.deepEqual(r, { error: 'vendor and packName required' });
    assert.equal(recorder.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_info: 404 surfaces as friendly error', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ error: 'pack not found' }, recorder, 404);

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

test('pack_info: 404 with version pin includes version in error', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ error: 'not found' }, recorder, 404);

  try {
    const r = await pack_info.execute(ctx(), {
      vendor: 'raindb',
      packName: 'social',
      version: '99.0.0',
    });
    assert.deepEqual(r, { error: 'pack not found: raindb/social@99.0.0' });
  } finally {
    globalThis.fetch = original;
  }
});

test('pack_info: vendor/pack names URL-encoded', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ pack: FULL_PACK }, recorder);

  try {
    await pack_info.execute(ctx(), {
      vendor: 'acme corp',
      packName: 'a/b',
    });
    // Spaces + slashes get percent-encoded
    assert.equal(
      recorder[0]!.url,
      'http://localhost:4000/api/marketplace/packs/acme%20corp/a%2Fb',
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// pack_get -- alias to pack_info
// ---------------------------------------------------------------------------

test('pack_get: behaves identically to pack_info (alias)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ pack: FULL_PACK }, recorder);

  try {
    const r = await pack_get.execute(ctx(), {
      vendor: 'raindb',
      packName: 'social',
    });
    const p = r as { vendor: string; packName: string };
    assert.equal(p.vendor, 'raindb');
    assert.equal(p.packName, 'social');
    assert.equal(pack_get.execute, pack_info.execute);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// pack_features -- delegates to pack_info, projects to features[]
// ---------------------------------------------------------------------------

test('pack_features: projects pack to features[]', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ pack: FULL_PACK }, recorder);

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
  globalThis.fetch = mockFetch({ error: 'nf' }, recorder, 404);

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

test('vendor_list: GET /api/marketplace/vendors -> vendors array', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      tagline: 'RainDB Marketplace',
      vendors: [
        {
          vendorId: 'raindb',
          displayName: 'RainDB',
          description: 'Platform vendor',
          verified: true,
          license: 'MIT',
        },
      ],
    },
    recorder,
  );

  try {
    const r = await vendor_list.execute(ctx(), {});
    assert.equal(recorder[0]!.url, 'http://localhost:4000/api/marketplace/vendors');
    const arr = r as Array<{ vendorId: string }>;
    assert.equal(arr.length, 1);
    assert.equal(arr[0]!.vendorId, 'raindb');
  } finally {
    globalThis.fetch = original;
  }
});

test('vendor_list: empty envelope returns []', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ tagline: '' }, recorder); // no vendors

  try {
    const r = await vendor_list.execute(ctx(), {});
    assert.deepEqual(r, []);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// vendor_info
// ---------------------------------------------------------------------------

test('vendor_info: GET /api/marketplace/vendors/<id>', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      vendor: {
        vendorId: 'raindb',
        displayName: 'RainDB',
        description: 'Platform vendor',
        verified: true,
        license: 'MIT',
      },
    },
    recorder,
  );

  try {
    const r = await vendor_info.execute(ctx(), { vendorId: 'raindb' });
    assert.equal(
      recorder[0]!.url,
      'http://localhost:4000/api/marketplace/vendors/raindb',
    );
    const v = r as { vendorId: string; verified: boolean; license?: string };
    assert.equal(v.vendorId, 'raindb');
    assert.equal(v.verified, true);
    assert.equal(v.license, 'MIT');
  } finally {
    globalThis.fetch = original;
  }
});

test('vendor_info: missing vendorId returns error (no fetch)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({}, recorder);

  try {
    const r = await vendor_info.execute(ctx(), {});
    assert.deepEqual(r, { error: 'vendorId required' });
    assert.equal(recorder.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('vendor_info: 404 surfaces as friendly error', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ error: 'nf' }, recorder, 404);

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

test('marketplace tools: metadata matches the tenant tool spec', () => {
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
