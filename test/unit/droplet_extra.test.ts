// droplet_extra.test.ts -- read-side + remaining mutating droplet
// tools (droplet_create has its own test file from M1).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  droplet_read_current,
  droplet_read_by_id,
  droplet_read_latest,
  droplet_list,
  droplet_keys,
  droplet_update,
  droplet_push_public,
  droplet_bulk_create,
  droplet_bulk_update,
} from '../../src/tools/droplet.js';
import type { ToolContext } from '../../src/registry/types.js';

interface FetchCallRecord {
  body: { query: string; variables: Record<string, unknown> };
}

function mockFetchSequence(
  responses: Array<unknown>,
  recorder: FetchCallRecord[],
): typeof fetch {
  let i = 0;
  return async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    recorder.push({ body });
    const resp = responses[i] ?? responses[responses.length - 1];
    i += 1;
    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function ctx(role: 'read' | 'write' | 'admin' = 'read'): ToolContext {
  return {
    creds: {
      apiKey: 'rdb_test',
      endpoint: 'http://localhost:8080/graphql',
    },
    role,
  };
}

const DROPLET_FIXTURE = {
  dropletId: '01970000-0000-0000-0000-000000000001',
  formationId: 'widget',
  schemaVersion: 1,
  ts: '2026-05-09T00:00:00Z',
  author: 'tester',
  tenantId: 'tenant-test',
  payload: { x: 'one' },
  pointerETag: 'etag-abc',
};

// ---------------------------------------------------------------------------
// droplet_read_current
// ---------------------------------------------------------------------------

test('droplet_read_current: emits readCurrent query with formation+scope', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [{ data: { readCurrent: DROPLET_FIXTURE } }],
    recorder,
  );

  try {
    const r = await droplet_read_current.execute(ctx(), {
      formation: 'widget',
      scope: 'x-key',
    });
    assert.match(recorder[0]!.body.query, /readCurrent/);
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['formationId'], 'widget');
    assert.equal(input['scope'], 'x-key');
    const d = r as typeof DROPLET_FIXTURE;
    assert.equal(d.dropletId, DROPLET_FIXTURE.dropletId);
  } finally {
    globalThis.fetch = original;
  }
});

test('droplet_read_current: parses JSON-encoded scope object', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [{ data: { readCurrent: DROPLET_FIXTURE } }],
    recorder,
  );

  try {
    await droplet_read_current.execute(ctx(), {
      formation: 'widget',
      scope: '{"id": "abc"}',
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.deepEqual(input['scope'], { id: 'abc' });
  } finally {
    globalThis.fetch = original;
  }
});

test('droplet_read_current: missing args returns error', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence([{ data: {} }], recorder);

  try {
    const r = await droplet_read_current.execute(ctx(), { formation: 'widget' });
    assert.deepEqual(r, { error: 'formation and scope are required' });
    assert.equal(recorder.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// droplet_read_by_id
// ---------------------------------------------------------------------------

test('droplet_read_by_id: emits readDroplet query', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [{ data: { readDroplet: DROPLET_FIXTURE } }],
    recorder,
  );

  try {
    await droplet_read_by_id.execute(ctx(), {
      formation: 'widget',
      id: '01970000-0000-0000-0000-000000000001',
    });
    assert.match(recorder[0]!.body.query, /readDroplet/);
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['formationId'], 'widget');
    assert.equal(input['dropletId'], '01970000-0000-0000-0000-000000000001');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// droplet_read_latest
// ---------------------------------------------------------------------------

test('droplet_read_latest: emits readLatest query', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [{ data: { readLatest: DROPLET_FIXTURE } }],
    recorder,
  );

  try {
    await droplet_read_latest.execute(ctx(), {
      formation: 'widget',
      index: 'by-id-latest',
      value: 'abc',
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['indexId'], 'by-id-latest');
    assert.equal(input['scopeValue'], 'abc');
  } finally {
    globalThis.fetch = original;
  }
});

test('droplet_read_latest: 404 surfaces as error', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [{ data: { readLatest: null } }],
    recorder,
  );

  try {
    const r = await droplet_read_latest.execute(ctx(), {
      formation: 'widget',
      index: 'by-id-latest',
      value: 'missing',
    });
    assert.deepEqual(r, { error: 'droplet not found: widget/by-id-latest/missing' });
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// droplet_list
// ---------------------------------------------------------------------------

test('droplet_list: emits listDroplets query with prefix + pageSize', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [
      {
        data: {
          listDroplets: {
            droplets: [DROPLET_FIXTURE],
            hasMore: false,
          },
        },
      },
    ],
    recorder,
  );

  try {
    const r = await droplet_list.execute(ctx(), {
      formation: 'widget',
      prefix: 'entities/widget/',
      pageSize: 50,
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['formationId'], 'widget');
    assert.equal(input['prefix'], 'entities/widget/');
    assert.equal(input['pageSize'], 50);
    const page = r as { droplets: Array<{ dropletId: string }>; hasMore: boolean };
    assert.equal(page.droplets.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// droplet_keys (paginates internally)
// ---------------------------------------------------------------------------

test('droplet_keys: paginates until hasMore=false', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [
      {
        data: {
          listKeys: {
            keys: [
              { key: 'a', size: 1, lastModified: '' },
              { key: 'b', size: 1, lastModified: '' },
            ],
            nextCursor: 'CURSOR1',
            hasMore: true,
            totalCount: 4,
          },
        },
      },
      {
        data: {
          listKeys: {
            keys: [
              { key: 'c', size: 1, lastModified: '' },
              { key: 'd', size: 1, lastModified: '' },
            ],
            nextCursor: null,
            hasMore: false,
            totalCount: 4,
          },
        },
      },
    ],
    recorder,
  );

  try {
    const r = await droplet_keys.execute(ctx(), { prefix: 'entities/widget/' });
    assert.equal(recorder.length, 2, 'paginated through 2 pages');
    const second = recorder[1]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(second['cursor'], 'CURSOR1');
    assert.deepEqual(r, { keys: ['a', 'b', 'c', 'd'] });
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// droplet_update
// ---------------------------------------------------------------------------

test('droplet_update: read + write with expectedETag CAS', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [
      // first call: readLatest
      {
        data: {
          readLatest: {
            ...DROPLET_FIXTURE,
            payload: { x: 'old', y: 1 },
            pointerETag: 'etag-current',
          },
        },
      },
      // second call: writeDroplet
      {
        data: {
          writeDroplet: {
            dropletId: 'new-droplet',
            pathsWritten: ['p'],
            floatPaths: [],
            publicUrls: [],
            vectorRefs: [],
            warnings: [],
            scopeValue: 'abc',
            durationMs: 5,
          },
        },
      },
    ],
    recorder,
  );

  try {
    const r = await droplet_update.execute(ctx('write'), {
      formation: 'widget',
      scope: 'abc',
      changes: { y: 2, z: 3 },
    });
    assert.equal(recorder.length, 2);
    const writeInput = recorder[1]!.body.variables['input'] as Record<string, unknown>;
    // Merged payload: old payload + changes
    assert.deepEqual(writeInput['payload'], { x: 'old', y: 2, z: 3 });
    assert.equal(writeInput['expectedETag'], 'etag-current');
    const wr = r as { dropletId: string };
    assert.equal(wr.dropletId, 'new-droplet');
  } finally {
    globalThis.fetch = original;
  }
});

test('droplet_update: 404 on read surfaces as error (no write attempted)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [{ data: { readLatest: null } }],
    recorder,
  );

  try {
    const r = await droplet_update.execute(ctx('write'), {
      formation: 'widget',
      scope: 'abc',
      changes: { y: 2 },
    });
    assert.equal(recorder.length, 1, 'no write attempted after 404 read');
    assert.deepEqual(r, { error: 'droplet not found: widget/abc' });
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// droplet_push_public
// ---------------------------------------------------------------------------

test('droplet_push_public: emits pushPublic mutation', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [
      {
        data: {
          pushPublic: {
            publicUrl: 'https://public/path',
            publicPath: 'tenants/x/public/y',
            contentType: 'image/png',
            size: 1024,
          },
        },
      },
    ],
    recorder,
  );

  try {
    const r = await droplet_push_public.execute(ctx('write'), {
      formation: 'widget',
      dropletId: 'd1',
    });
    assert.match(recorder[0]!.body.query, /pushPublic/);
    const pp = r as { publicUrl: string };
    assert.equal(pp.publicUrl, 'https://public/path');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// droplet_bulk_create
// ---------------------------------------------------------------------------

test('droplet_bulk_create: per-entry success/failure', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  // Three writes: success, failure (server error), success.
  let i = 0;
  globalThis.fetch = async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    recorder.push({ body });
    const responses = [
      { data: { writeDroplet: { dropletId: 'd1', pathsWritten: [], floatPaths: [], publicUrls: [], vectorRefs: [], warnings: [], durationMs: 1 } } },
      { errors: [{ message: 'validation failed' }] },
      { data: { writeDroplet: { dropletId: 'd3', pathsWritten: [], floatPaths: [], publicUrls: [], vectorRefs: [], warnings: [], durationMs: 1 } } },
    ];
    const resp = responses[i] ?? responses[2];
    i += 1;
    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const r = await droplet_bulk_create.execute(ctx('write'), {
      formation: 'widget',
      entries: [{ a: 1 }, { a: 2 }, { a: 3 }],
    });
    const results = r as Array<{ index: number; succeeded: boolean; dropletId?: string; error?: string }>;
    assert.equal(results.length, 3);
    assert.equal(results[0]!.succeeded, true);
    assert.equal(results[0]!.dropletId, 'd1');
    assert.equal(results[1]!.succeeded, false);
    assert.match(results[1]!.error ?? '', /validation failed/);
    assert.equal(results[2]!.succeeded, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('droplet_bulk_create: rejects non-object entries', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence([], recorder);

  try {
    const r = await droplet_bulk_create.execute(ctx('write'), {
      formation: 'widget',
      entries: ['not an object', { a: 1 }],
    });
    const results = r as Array<{ index: number; succeeded: boolean; error?: string }>;
    assert.equal(results[0]!.succeeded, false);
    assert.match(results[0]!.error ?? '', /not an object/);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// droplet_bulk_update
// ---------------------------------------------------------------------------

test('droplet_bulk_update: rejects entry missing scopeKey', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence([], recorder);

  try {
    const r = await droplet_bulk_update.execute(ctx('write'), {
      formation: 'widget',
      scopeKey: 'modelId',
      entries: [{ name: 'no scope here' }],
    });
    const results = r as Array<{ index: number; succeeded: boolean; error?: string }>;
    assert.equal(results.length, 1);
    assert.equal(results[0]!.succeeded, false);
    assert.match(results[0]!.error ?? '', /missing scope key/);
    assert.equal(recorder.length, 0, 'no GraphQL calls when validation fails');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// metadata parity
// ---------------------------------------------------------------------------

test('droplet read-side: metadata matches Go reference', () => {
  assert.equal(droplet_read_current.minRole, 'read');
  assert.ok(!droplet_read_current.modifiesResource);
  assert.deepEqual(droplet_read_current.parameters.required, ['formation', 'scope']);

  assert.equal(droplet_read_by_id.minRole, 'read');
  assert.deepEqual(droplet_read_by_id.parameters.required, ['formation', 'id']);

  assert.equal(droplet_read_latest.minRole, 'read');
  assert.deepEqual(droplet_read_latest.parameters.required, ['formation', 'index', 'value']);

  assert.equal(droplet_list.minRole, 'read');
  assert.deepEqual(droplet_list.parameters.required, ['formation']);

  assert.equal(droplet_keys.minRole, 'read');
  assert.deepEqual(droplet_keys.parameters.required, ['prefix']);
});

test('droplet mutating: metadata matches Go reference', () => {
  assert.equal(droplet_update.minRole, 'write');
  assert.equal(droplet_update.modifiesResource, true);
  assert.deepEqual(
    droplet_update.parameters.required,
    ['formation', 'scope', 'changes'],
  );

  assert.equal(droplet_push_public.minRole, 'write');
  assert.equal(droplet_push_public.modifiesResource, true);

  assert.equal(droplet_bulk_create.minRole, 'write');
  assert.equal(droplet_bulk_create.modifiesResource, true);
  assert.deepEqual(
    droplet_bulk_create.parameters.required,
    ['formation', 'entries'],
  );

  assert.equal(droplet_bulk_update.minRole, 'write');
  assert.equal(droplet_bulk_update.modifiesResource, true);
  assert.deepEqual(
    droplet_bulk_update.parameters.required,
    ['formation', 'scopeKey', 'entries'],
  );
});
