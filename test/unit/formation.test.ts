// formation.test.ts -- formation_list, formation_describe,
// formation_publish tool tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formation_list,
  formation_describe,
  formation_publish,
} from '../../src/tools/formation.js';
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

test('formation_list: emits listFormations query and returns array', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        listFormations: [
          { formationId: 'fdn_documents', schemaVersion: 2, scopeKey: 'documentId', visibility: 'internal' },
          { formationId: 'platform_user', schemaVersion: 1, scopeKey: 'userId', visibility: 'internal' },
        ],
      },
    },
    recorder,
  );

  try {
    const result = await formation_list.execute(ctx(), {});
    assert.match(recorder[0]!.body.query, /listFormations/);
    const arr = result as Array<{ formationId: string }>;
    assert.equal(arr.length, 2);
    assert.equal(arr[0]!.formationId, 'fdn_documents');
  } finally {
    globalThis.fetch = original;
  }
});

test('formation_describe: emits DescribeFormation query with formationId', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        describeFormation: {
          formationId: 'fdn_documents',
          schemaVersion: 2,
          scopeKey: 'documentId',
          visibility: 'internal',
          config: { autoGenId: true, indexes: [] },
          schema: { type: 'object', properties: {} },
        },
      },
    },
    recorder,
  );

  try {
    const result = await formation_describe.execute(ctx(), { formation: 'fdn_documents' });
    assert.match(recorder[0]!.body.query, /describeFormation/);
    assert.deepEqual(recorder[0]!.body.variables, { formationId: 'fdn_documents' });
    const r = result as { formationId: string; schemaVersion: number };
    assert.equal(r.formationId, 'fdn_documents');
    assert.equal(r.schemaVersion, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('formation_describe: missing formation returns friendly error', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: {} }, recorder);

  try {
    const result = await formation_describe.execute(ctx(), {});
    assert.deepEqual(result, { error: 'formation required' });
    assert.equal(recorder.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('formation_describe: 404 surfaces as error string', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: { describeFormation: null } }, recorder);

  try {
    const result = await formation_describe.execute(ctx(), { formation: 'missing' });
    assert.deepEqual(result, { error: 'formation not found: missing' });
  } finally {
    globalThis.fetch = original;
  }
});

test('formation_publish: emits PublishFormation mutation with full input', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        publishFormation: {
          formationId: 'my_formation',
          schemaVersion: 3,
          pathsWritten: [
            'formations/my_formation/v3/',
            'formations/my_formation/current/',
          ],
        },
      },
    },
    recorder,
  );

  try {
    const result = await formation_publish.execute(ctx('admin'), {
      formation: 'my_formation',
      config: { autoGenId: true, indexes: [] },
      schema: { type: 'object' },
      schemaVersion: 3,
    });
    assert.match(recorder[0]!.body.query, /publishFormation/);
    const vars = recorder[0]!.body.variables;
    assert.equal(vars['formationId'], 'my_formation');
    assert.equal(vars['schemaVersion'], 3);
    assert.deepEqual(vars['config'], { autoGenId: true, indexes: [] });
    assert.deepEqual(vars['schema'], { type: 'object' });
    const r = result as { schemaVersion: number; pathsWritten: string[] };
    assert.equal(r.schemaVersion, 3);
    assert.equal(r.pathsWritten.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('formation_publish: validates required fields before GraphQL call', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: {} }, recorder);

  try {
    const r1 = await formation_publish.execute(ctx('admin'), {
      formation: '',
      config: {},
      schemaVersion: 1,
    });
    assert.ok((r1 as { error: string }).error.includes('formation'));

    const r2 = await formation_publish.execute(ctx('admin'), {
      formation: 'x',
      schemaVersion: 1,
    });
    assert.ok((r2 as { error: string }).error.includes('config'));

    const r3 = await formation_publish.execute(ctx('admin'), {
      formation: 'x',
      config: {},
      schemaVersion: 0,
    });
    assert.ok((r3 as { error: string }).error.includes('schemaVersion'));

    assert.equal(recorder.length, 0, 'no GraphQL call when validation fails');
  } finally {
    globalThis.fetch = original;
  }
});

test('formation_publish: omitted schema becomes empty object (Go side requires JSON!)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        publishFormation: {
          formationId: 'x',
          schemaVersion: 1,
          pathsWritten: [],
        },
      },
    },
    recorder,
  );

  try {
    await formation_publish.execute(ctx('admin'), {
      formation: 'x',
      config: { foo: 'bar' },
      schemaVersion: 1,
    });
    assert.deepEqual(recorder[0]!.body.variables['schema'], {});
  } finally {
    globalThis.fetch = original;
  }
});

test('formation_*: tool metadata matches the tenant tool spec', () => {
  assert.equal(formation_list.name, 'formation_list');
  assert.equal(formation_list.minRole, 'read');
  assert.ok(!formation_list.modifiesResource);

  assert.equal(formation_describe.name, 'formation_describe');
  assert.equal(formation_describe.minRole, 'read');
  assert.ok(!formation_describe.modifiesResource);
  assert.deepEqual(formation_describe.parameters.required, ['formation']);

  assert.equal(formation_publish.name, 'formation_publish');
  assert.equal(formation_publish.minRole, 'admin');
  assert.equal(formation_publish.modifiesResource, true);
  assert.deepEqual(
    formation_publish.parameters.required,
    ['formation', 'config', 'schemaVersion'],
  );
});
