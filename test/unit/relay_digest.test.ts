// relay_digest.test.ts -- relay_* + digest_* tools.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  relay_queue,
  relay_status,
  relay_inspect,
  relay_logs,
  relay_tree,
  relay_entity,
} from '../../src/tools/relay.js';
import { digest_list, digest_show } from '../../src/tools/digest.js';
import type { ToolContext } from '../../src/registry/types.js';
import { makeNodeHost } from '../../src/host/node.js';

interface FetchCallRecord {
  body: { query: string; variables: Record<string, unknown> };
}

function mockFetchSequence(
  responses: unknown[],
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

const RELAY_RESULT_FIXTURE = {
  relayId: 'r-root',
  formationId: 'fdn_documents',
  entityId: 'doc-1',
  status: 'complete',
  details: {
    relayType: 'digest-extract',
    startedAt: '2026-05-09T10:00:00Z',
    attempt: 1,
  },
  logIds: ['log-1', 'log-2'],
};

// ---------------------------------------------------------------------------
// relay_status / relay_inspect
// ---------------------------------------------------------------------------

test('relay_status: projects RelayResult to summary', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [{ data: { readRelay: RELAY_RESULT_FIXTURE } }],
    recorder,
  );

  try {
    const r = await relay_status.execute(ctx(), {
      formation: 'fdn_documents',
      entityId: 'doc-1',
      relayId: 'r-root',
    });
    const summary = r as { relayId: string; relayType: string; status: string; attempt: number };
    assert.equal(summary.relayId, 'r-root');
    assert.equal(summary.relayType, 'digest-extract');
    assert.equal(summary.status, 'complete');
    assert.equal(summary.attempt, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('relay_status: missing required args returns error', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence([{ data: {} }], recorder);

  try {
    const r = await relay_status.execute(ctx(), { formation: 'f' });
    assert.match((r as { error: string }).error, /formation, entityId, relayId/);
    assert.equal(recorder.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('relay_inspect: pulls subTasks from details', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [
      {
        data: {
          readRelay: {
            ...RELAY_RESULT_FIXTURE,
            details: {
              ...RELAY_RESULT_FIXTURE.details,
              subTasks: ['s1', 's2', 's3'],
            },
          },
        },
      },
    ],
    recorder,
  );

  try {
    const r = await relay_inspect.execute(ctx(), {
      formation: 'fdn_documents',
      entityId: 'doc-1',
      relayId: 'r-root',
    });
    const view = r as { subTasks?: string[]; logIds?: string[] };
    assert.deepEqual(view.subTasks, ['s1', 's2', 's3']);
    assert.deepEqual(view.logIds, ['log-1', 'log-2']);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// relay_logs (two-step read)
// ---------------------------------------------------------------------------

test('relay_logs: reads to get logIds, then re-reads with logIds set', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [
      // first read: returns the logIds
      { data: { readRelay: RELAY_RESULT_FIXTURE } },
      // second read: includes the logs[]
      {
        data: {
          readRelay: {
            ...RELAY_RESULT_FIXTURE,
            logs: [
              { logId: 'log-1', type: 'info', data: 'started', ts: '2026-05-09T10:00:00Z' },
              { logId: 'log-2', type: 'info', data: 'done', ts: '2026-05-09T10:00:05Z' },
            ],
          },
        },
      },
    ],
    recorder,
  );

  try {
    const r = await relay_logs.execute(ctx(), {
      formation: 'fdn_documents',
      entityId: 'doc-1',
      relayId: 'r-root',
    });
    assert.equal(recorder.length, 2);
    const secondInput = recorder[1]!.body.variables['input'] as Record<string, unknown>;
    assert.deepEqual(secondInput['logIds'], ['log-1', 'log-2']);
    const logs = r as Array<{ logId: string }>;
    assert.equal(logs.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('relay_logs: empty when there are no logIds (single read)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [
      { data: { readRelay: { ...RELAY_RESULT_FIXTURE, logIds: [] } } },
    ],
    recorder,
  );

  try {
    const r = await relay_logs.execute(ctx(), {
      formation: 'fdn_documents',
      entityId: 'doc-1',
      relayId: 'r-root',
    });
    assert.equal(recorder.length, 1, 'no second read when no logIds');
    assert.deepEqual(r, []);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// relay_tree
// ---------------------------------------------------------------------------

test('relay_tree: emits readRelay with tree=true', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [
      {
        data: {
          readRelay: {
            ...RELAY_RESULT_FIXTURE,
            subRelays: [
              {
                relayId: 'sub-1',
                formationId: 'fdn_documents',
                entityId: 'doc-1',
                status: 'complete',
                details: { relayType: 'digest-chunk' },
              },
            ],
          },
        },
      },
    ],
    recorder,
  );

  try {
    await relay_tree.execute(ctx(), {
      formation: 'fdn_documents',
      entityId: 'doc-1',
      relayId: 'r-root',
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['tree'], true);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// relay_queue / relay_entity (listKeys-driven)
// ---------------------------------------------------------------------------

test('relay_queue: walks listKeys against indexes/<queue>/by-formation/ prefix', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [
      {
        data: {
          listKeys: {
            keys: [
              { key: 'indexes/digest-queue/by-formation/fdn_documents/r1.json', size: 1, lastModified: 1746784800000 },
              { key: 'indexes/digest-queue/by-formation/fdn_documents/r2.json', size: 1, lastModified: 1746784860000 },
            ],
            nextCursor: null,
            hasMore: false,
          },
        },
      },
    ],
    recorder,
  );

  try {
    const r = await relay_queue.execute(ctx(), {
      queueFormation: 'digest-queue',
      formationFilter: 'fdn_documents',
    });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    assert.equal(input['prefix'], 'indexes/digest-queue/by-formation/fdn_documents/');
    const entries = r as Array<{ relayId: string; formationId: string }>;
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.relayId, 'r1');
    assert.equal(entries[0]!.formationId, 'fdn_documents');
  } finally {
    globalThis.fetch = original;
  }
});

test('relay_entity: dedupes relayIds across listKeys pages', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [
      {
        data: {
          listKeys: {
            keys: [
              { key: 'entities/fdn_documents/doc-1/relays/relay-A/details.json' },
              { key: 'entities/fdn_documents/doc-1/relays/relay-A/log-1.json' },
              { key: 'entities/fdn_documents/doc-1/relays/relay-B/details.json' },
            ],
            nextCursor: null,
            hasMore: false,
          },
        },
      },
    ],
    recorder,
  );

  try {
    const r = await relay_entity.execute(ctx(), {
      formation: 'fdn_documents',
      entityId: 'doc-1',
    });
    assert.deepEqual(r, ['relay-A', 'relay-B']);
  } finally {
    globalThis.fetch = original;
  }
});

test('relay tools: metadata matches the tenant tool spec', () => {
  for (const t of [
    relay_queue,
    relay_status,
    relay_inspect,
    relay_logs,
    relay_tree,
    relay_entity,
  ]) {
    assert.equal(t.minRole, 'read', `${t.name}: minRole=read`);
    assert.ok(!t.modifiesResource, `${t.name}: modifiesResource=false`);
  }
});

// ---------------------------------------------------------------------------
// digest_list / digest_show
// ---------------------------------------------------------------------------

test('digest_list: walks formation -> entities -> relay roots -> tree', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = mockFetchSequence(
    [
      // describeFormation -> scopeKey
      { data: { describeFormation: { scopeKey: 'documentId' } } },
      // listDroplets -> 1 entity
      {
        data: {
          listDroplets: {
            droplets: [
              {
                dropletId: 'd1',
                payload: { documentId: 'doc-1', filename: 'spec.pdf' },
              },
            ],
            hasMore: false,
          },
        },
      },
      // listKeys (root relays for doc-1) -> 1 root
      {
        data: {
          listKeys: {
            keys: [{ key: 'entities/fdn_documents/doc-1/relays/r-root/details.json' }],
            nextCursor: null,
            hasMore: false,
          },
        },
      },
      // readRelay tree
      {
        data: {
          readRelay: {
            relayId: 'r-root',
            formationId: 'fdn_documents',
            entityId: 'doc-1',
            status: 'complete',
            details: {
              relayType: 'digest-root',
              startedAt: '2026-05-09T10:00:00Z',
              input: {
                actionFormation: 'digest',
                payload: { filename: 'spec.pdf' },
              },
            },
            subRelays: [
              {
                relayId: 'r-extract',
                status: 'complete',
                formationId: 'fdn_documents',
                entityId: 'doc-1',
                details: {
                  relayType: 'digest-extract',
                  startedAt: '2026-05-09T10:00:01Z',
                  completedAt: '2026-05-09T10:00:05Z',
                },
              },
              {
                relayId: 'r-chunk',
                status: 'complete',
                formationId: 'fdn_documents',
                entityId: 'doc-1',
                details: {
                  relayType: 'digest-chunk',
                  startedAt: '2026-05-09T10:00:05Z',
                  completedAt: '2026-05-09T10:00:08Z',
                },
              },
            ],
          },
        },
      },
    ],
    recorder,
  );

  try {
    const r = await digest_list.execute(ctx(), { formation: 'fdn_documents' });
    const arr = r as Array<{ entityId: string; status: string; stages?: Array<{ name: string; durationMs?: number }> }>;
    assert.equal(arr.length, 1);
    const row = arr[0]!;
    assert.equal(row.entityId, 'doc-1');
    assert.equal(row.status, 'complete');
    assert.ok(row.stages);
    assert.equal(row.stages!.length, 2);
    assert.equal(row.stages![0]!.name, 'digest-extract');
    assert.equal(row.stages![0]!.durationMs, 4000);
  } finally {
    globalThis.fetch = original;
  }
});

test('digest_list: empty formation returns empty array', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = mockFetchSequence(
    [
      { data: { describeFormation: { scopeKey: 'id' } } },
      { data: { listDroplets: { droplets: [], hasMore: false } } },
    ],
    recorder,
  );

  try {
    const r = await digest_list.execute(ctx(), { formation: 'empty_formation' });
    assert.deepEqual(r, []);
  } finally {
    globalThis.fetch = original;
  }
});

test('digest_show: returns single status synthesized for the entity', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = mockFetchSequence(
    [
      // listKeys -> 1 root for the entity
      {
        data: {
          listKeys: {
            keys: [{ key: 'entities/fdn_documents/doc-1/relays/r-root/details.json' }],
            nextCursor: null,
            hasMore: false,
          },
        },
      },
      // readRelay tree (no input.payload.filename so we leave filename empty)
      {
        data: {
          readRelay: {
            relayId: 'r-root',
            formationId: 'fdn_documents',
            entityId: 'doc-1',
            status: 'running',
            details: {
              relayType: 'digest-root',
              startedAt: '2026-05-09T10:00:00Z',
            },
            subRelays: [],
          },
        },
      },
    ],
    recorder,
  );

  try {
    const r = await digest_show.execute(ctx(), {
      formation: 'fdn_documents',
      entityId: 'doc-1',
    });
    const status = r as { entityId: string; status: string };
    assert.equal(status.entityId, 'doc-1');
    assert.equal(status.status, 'running');
  } finally {
    globalThis.fetch = original;
  }
});

test('digest_show: no-action-found when no roots exist', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = mockFetchSequence(
    [
      // listKeys -> empty
      {
        data: {
          listKeys: { keys: [], nextCursor: null, hasMore: false },
        },
      },
    ],
    recorder,
  );

  try {
    const r = await digest_show.execute(ctx(), {
      formation: 'fdn_documents',
      entityId: 'doc-missing',
    });
    const status = r as { status: string };
    assert.equal(status.status, 'no-action-found');
  } finally {
    globalThis.fetch = original;
  }
});

test('digest tools: metadata matches the tenant tool spec', () => {
  assert.equal(digest_list.minRole, 'read');
  assert.ok(!digest_list.modifiesResource);
  assert.deepEqual(digest_list.parameters.required, ['formation']);

  assert.equal(digest_show.minRole, 'read');
  assert.deepEqual(digest_show.parameters.required, ['formation', 'entityId']);
});
