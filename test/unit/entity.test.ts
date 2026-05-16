// entity.test.ts -- entity-lifecycle tools.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  entity_version_history,
  entity_tag,
  entity_untag,
  entity_mark_for_expiration,
  entity_cancel_expiration,
  entity_expire,
} from '../../src/tools/entity.js';
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

function ctx(role: 'read' | 'write' | 'admin' = 'write'): ToolContext {
  return {
    creds: {
      apiKey: 'rdb_test',
      endpoint: 'http://localhost:8080/graphql',
    },
    host: makeNodeHost({ apiKey: 'rdb_test', endpoint: 'http://localhost:8080/graphql' }),
    role,
  };
}

test('entity_version_history: walks listKeys + projects to versions[]', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        listKeys: {
          keys: [
            { key: 'entities/widget/abc/2026/05/09/d1.json' },
            { key: 'entities/widget/abc/2026/05/10/d2.json' },
            { key: 'entities/widget/abc/2026/05/10/notjson.txt' },
          ],
          nextCursor: null,
          hasMore: false,
        },
      },
    },
    recorder,
  );

  try {
    const r = await entity_version_history.execute(ctx('read'), {
      formation: 'widget',
      scope: 'abc',
    });
    const versions = r as Array<{ dropletId: string; key: string }>;
    // Newest-first ordering (Go op reverses the list at the end).
    assert.equal(versions.length, 2, 'non-json key skipped');
    assert.equal(versions[0]!.dropletId, 'd2');
    assert.equal(versions[1]!.dropletId, 'd1');
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['prefix'], 'entities/widget/abc/');
  } finally {
    globalThis.fetch = original;
  }
});

test('entity_tag: emits TagEntity mutation with map[string]string', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        tagEntity: {
          formationId: 'widget',
          scopeValue: 'abc',
          success: true,
        },
      },
    },
    recorder,
  );

  try {
    const r = await entity_tag.execute(ctx(), {
      formation: 'widget',
      scope: 'abc',
      tags: { color: 'red', priority: 'high', count: 5 }, // count is non-string -> dropped
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.deepEqual(input['tags'], { color: 'red', priority: 'high' });
    assert.deepEqual(r, { tagged: 2 });
  } finally {
    globalThis.fetch = original;
  }
});

test('entity_tag: empty tags after coercion returns error', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: {} }, recorder);

  try {
    const r = await entity_tag.execute(ctx(), {
      formation: 'widget',
      scope: 'abc',
      tags: { count: 5 }, // non-string only -> all dropped
    });
    assert.match((r as { error: string }).error, /at least one string-valued/);
    assert.equal(recorder.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('entity_untag: emits UntagEntity mutation with tagKeys[]', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        untagEntity: {
          formationId: 'widget',
          scopeValue: 'abc',
          success: true,
        },
      },
    },
    recorder,
  );

  try {
    const r = await entity_untag.execute(ctx(), {
      formation: 'widget',
      scope: 'abc',
      tagKeys: ['color', 'priority'],
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.deepEqual(input['tagKeys'], ['color', 'priority']);
    assert.deepEqual(r, { untagged: 2 });
  } finally {
    globalThis.fetch = original;
  }
});

test('entity_mark_for_expiration: wraps tagEntity with expire-after-days', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        tagEntity: {
          formationId: 'widget',
          scopeValue: 'abc',
          success: true,
        },
      },
    },
    recorder,
  );

  try {
    const r = await entity_mark_for_expiration.execute(ctx(), {
      formation: 'widget',
      scope: 'abc',
      days: 30,
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.deepEqual(input['tags'], { 'expire-after-days': '30' });
    assert.deepEqual(r, { days: 30 });
  } finally {
    globalThis.fetch = original;
  }
});

test('entity_mark_for_expiration: rejects non-positive days', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: {} }, recorder);

  try {
    const r = await entity_mark_for_expiration.execute(ctx(), {
      formation: 'widget',
      scope: 'abc',
      days: 0,
    });
    assert.match((r as { error: string }).error, /days/);
    assert.equal(recorder.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('entity_cancel_expiration: wraps untagEntity with expire-after-days key', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        untagEntity: {
          formationId: 'widget',
          scopeValue: 'abc',
          success: true,
        },
      },
    },
    recorder,
  );

  try {
    const r = await entity_cancel_expiration.execute(ctx(), {
      formation: 'widget',
      scope: 'abc',
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.deepEqual(input['tagKeys'], ['expire-after-days']);
    assert.deepEqual(r, { cancelled: true });
  } finally {
    globalThis.fetch = original;
  }
});

test('entity_expire: emits ExpireDroplet mutation', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        expireDroplet: {
          formationId: 'widget',
          scopeValue: 'abc',
          success: true,
        },
      },
    },
    recorder,
  );

  try {
    const r = await entity_expire.execute(ctx('admin'), {
      formation: 'widget',
      scope: 'abc',
    });
    assert.match(recorder[0]!.body.query, /expireDroplet/);
    assert.deepEqual(r, { expired: true });
  } finally {
    globalThis.fetch = original;
  }
});

test('entity tools: metadata matches Go reference', () => {
  assert.equal(entity_version_history.minRole, 'read');
  assert.ok(!entity_version_history.modifiesResource);
  assert.deepEqual(entity_version_history.parameters.required, ['formation', 'scope']);

  assert.equal(entity_tag.minRole, 'write');
  assert.equal(entity_tag.modifiesResource, true);
  assert.equal(entity_untag.modifiesResource, true);
  assert.equal(entity_mark_for_expiration.modifiesResource, true);
  assert.equal(entity_cancel_expiration.modifiesResource, true);

  // entity_expire is admin (destructive shortcut).
  assert.equal(entity_expire.minRole, 'admin');
  assert.equal(entity_expire.modifiesResource, true);
});
