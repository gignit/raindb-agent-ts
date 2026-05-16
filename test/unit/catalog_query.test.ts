// catalog_query.test.ts -- catalog + sql_execute + vector_search.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  catalog_list,
  catalog_tree,
  catalog_insert,
  catalog_update,
  catalog_delete,
  catalog_transfer,
} from '../../src/tools/catalog.js';
import { sql_execute, vector_search } from '../../src/tools/query.js';
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

function ctx(role: 'read' | 'write' | 'admin' = 'read'): ToolContext {
  return {
    creds: {
      apiKey: 'rdb_test',
      endpoint: 'http://localhost:8080/graphql',
    },
    host: makeNodeHost({ apiKey: 'rdb_test', endpoint: 'http://localhost:8080/graphql' }),
    role,
  };
}

// ---------------------------------------------------------------------------
// catalog_list
// ---------------------------------------------------------------------------

test('catalog_list: emits catalogList query', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    { data: { catalogList: { entries: [{ id: 'a' }, { id: 'b' }] } } },
    recorder,
  );

  try {
    const r = await catalog_list.execute(ctx(), {
      formation: 'fdn_folders',
      catalogScope: 'root',
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['formationId'], 'fdn_folders');
    assert.equal(input['catalogScopeValue'], 'root');
    const result = r as { entries: Array<Record<string, unknown>> };
    assert.equal(result.entries.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// catalog_tree
// ---------------------------------------------------------------------------

test('catalog_tree: passes maxDepth + handles 404', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        catalogTree: {
          catalogId: 'root',
          displayName: 'Root',
          entries: [],
          children: [],
        },
      },
    },
    recorder,
  );

  try {
    await catalog_tree.execute(ctx(), {
      formation: 'fdn_folders',
      catalogScope: 'root',
      maxDepth: 3,
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['maxDepth'], 3);
  } finally {
    globalThis.fetch = original;
  }
});

test('catalog_tree: 404 surfaces as error', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: { catalogTree: null } }, recorder);

  try {
    const r = await catalog_tree.execute(ctx(), {
      formation: 'fdn_folders',
      catalogScope: 'missing',
    });
    assert.deepEqual(r, { error: 'catalog not found: missing' });
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// catalog_insert / catalog_update / catalog_delete / catalog_transfer
// ---------------------------------------------------------------------------

test('catalog_insert: emits catalogInsert mutation', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        catalogInsert: {
          dropletId: 'd1',
          scopeValue: 'root',
          entry: { name: 'new' },
          warnings: [],
        },
      },
    },
    recorder,
  );

  try {
    await catalog_insert.execute(ctx('write'), {
      formation: 'fdn_folders',
      catalogScope: 'root',
      entry: { name: 'new', kind: 'folder' },
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['formationId'], 'fdn_folders');
    assert.deepEqual(input['entry'], { name: 'new', kind: 'folder' });
  } finally {
    globalThis.fetch = original;
  }
});

test('catalog_update: requires changes object', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: {} }, recorder);

  try {
    const r = await catalog_update.execute(ctx('write'), {
      formation: 'f',
      catalogScope: 'root',
      refValue: 'r',
    });
    assert.match((r as { error: string }).error, /changes/);
    assert.equal(recorder.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('catalog_delete: emits catalogDelete mutation', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        catalogDelete: {
          dropletId: 'd1',
          scopeValue: 'root',
          entry: { ref: 'r' },
          warnings: [],
        },
      },
    },
    recorder,
  );

  try {
    await catalog_delete.execute(ctx('write'), {
      formation: 'fdn_folders',
      catalogScope: 'root',
      refValue: 'doc-1',
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['refValue'], 'doc-1');
  } finally {
    globalThis.fetch = original;
  }
});

test('catalog_transfer: passes source + target + ref', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        catalogTransfer: {
          targetDropletId: 'd2',
          sourceDropletId: 'd1',
          entry: { ref: 'r' },
          warnings: [],
        },
      },
    },
    recorder,
  );

  try {
    const r = await catalog_transfer.execute(ctx('write'), {
      formation: 'fdn_folders',
      sourceScope: 'folder-a',
      targetScope: 'folder-b',
      refValue: 'doc-1',
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['sourceScopeValue'], 'folder-a');
    assert.equal(input['targetScopeValue'], 'folder-b');
    const result = r as { targetDropletId: string };
    assert.equal(result.targetDropletId, 'd2');
  } finally {
    globalThis.fetch = original;
  }
});

test('catalog tools: metadata matches Go reference', () => {
  assert.equal(catalog_list.minRole, 'read');
  assert.ok(!catalog_list.modifiesResource);
  assert.equal(catalog_tree.minRole, 'read');

  for (const t of [catalog_insert, catalog_update, catalog_delete, catalog_transfer]) {
    assert.equal(t.minRole, 'write', `${t.name}: minRole=write`);
    assert.equal(t.modifiesResource, true, `${t.name}: modifiesResource=true`);
  }
});

// ---------------------------------------------------------------------------
// sql_execute (with SELECT-only guard)
// ---------------------------------------------------------------------------

test('sql_execute: accepts SELECT through executeSQL', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        executeSQL: {
          columns: ['c'],
          rows: [['1']],
          rowCount: 1,
          durationMs: 5,
        },
      },
    },
    recorder,
  );

  try {
    const r = await sql_execute.execute(ctx(), {
      query: 'SELECT 1 AS c',
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['sql'], 'SELECT 1 AS c');
    const result = r as { rowCount: number };
    assert.equal(result.rowCount, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('sql_execute: accepts WITH (CTEs)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        executeSQL: { columns: [], rows: [], rowCount: 0, durationMs: 1 },
      },
    },
    recorder,
  );

  try {
    const r = await sql_execute.execute(ctx(), {
      query: 'WITH t AS (SELECT 1) SELECT * FROM t',
    });
    assert.ok(!('error' in (r as Record<string, unknown>)));
  } finally {
    globalThis.fetch = original;
  }
});

test('sql_execute: rejects DDL/DML keywords', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: {} }, recorder);

  const forbidden = [
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET x=1',
    'DELETE FROM t',
    'DROP TABLE t',
    'CREATE TABLE t (x INT)',
    'ALTER TABLE t ADD COLUMN y INT',
    'TRUNCATE t',
    'PRAGMA something',
  ];

  try {
    for (const sql of forbidden) {
      const r = await sql_execute.execute(ctx(), { query: sql });
      assert.ok('error' in (r as Record<string, unknown>),
        `must reject: ${sql}`);
    }
    assert.equal(recorder.length, 0, 'no SQL reached the server');
  } finally {
    globalThis.fetch = original;
  }
});

test('sql_execute: strips comments before checking first token', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        executeSQL: { columns: [], rows: [], rowCount: 0, durationMs: 1 },
      },
    },
    recorder,
  );

  try {
    // Leading comment should be stripped, then SELECT is found.
    const r = await sql_execute.execute(ctx(), {
      query: '-- hello\n/* block comment */\nSELECT 1',
    });
    assert.ok(!('error' in (r as Record<string, unknown>)));
    assert.equal(recorder.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('sql_execute: forwards formation scope', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        executeSQL: { columns: [], rows: [], rowCount: 0, durationMs: 1 },
      },
    },
    recorder,
  );

  try {
    await sql_execute.execute(ctx(), {
      query: 'SELECT * FROM widgets',
      formation: 'widgets',
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['formationId'], 'widgets');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// vector_search
// ---------------------------------------------------------------------------

test('vector_search: emits vectorSearch query with full input', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        vectorSearch: {
          hits: [
            {
              key: 'chunk-1',
              score: 0.95,
              text: 'hello',
              metadata: { documentId: 'd1' },
            },
          ],
          model: 'fdn/embed',
        },
      },
    },
    recorder,
  );

  try {
    const r = await vector_search.execute(ctx(), {
      formation: 'fdn_embeddings',
      model: 'fdn/embed',
      query: 'find me hellos',
      topK: 5,
      hybrid: true,
      filter: { documentId: 'd1' },
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['formationId'], 'fdn_embeddings');
    assert.equal(input['model'], 'fdn/embed');
    assert.equal(input['query'], 'find me hellos');
    assert.equal(input['topK'], 5);
    assert.equal(input['hybrid'], true);
    assert.deepEqual(input['filter'], { documentId: 'd1' });
    const result = r as { hits: Array<{ score: number }> };
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]!.score, 0.95);
  } finally {
    globalThis.fetch = original;
  }
});

test('vector_search: empty hits when server returns null', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: { vectorSearch: null } }, recorder);

  try {
    const r = await vector_search.execute(ctx(), {
      formation: 'fdn_embeddings',
      model: 'fdn/embed',
      query: 'anything',
    });
    const result = r as { hits: unknown[] };
    assert.deepEqual(result.hits, []);
  } finally {
    globalThis.fetch = original;
  }
});

test('query tools: metadata matches Go reference', () => {
  assert.equal(sql_execute.minRole, 'read');
  assert.ok(!sql_execute.modifiesResource);
  assert.deepEqual(sql_execute.parameters.required, ['query']);

  assert.equal(vector_search.minRole, 'read');
  assert.deepEqual(vector_search.parameters.required, ['formation', 'model', 'query']);
});
