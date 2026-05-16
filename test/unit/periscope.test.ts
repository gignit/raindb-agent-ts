// periscope.test.ts -- 17 read-only tools wrapping periscope GraphQL
// queries. The pattern is uniform; tests focus on (a) the right
// query name fires, (b) variables propagate correctly, (c) optional
// args are omitted when unset, (d) required-arg validation kicks
// in before any GraphQL call.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  periscope_status,
  periscope_formation_list,
  periscope_formation_describe,
  periscope_formation_lint,
  periscope_audit,
  periscope_reconcile,
  periscope_tier_list,
  periscope_tier_describe,
  periscope_tier_cursor,
  periscope_snapshot_list,
  periscope_snapshot_get,
  periscope_pool_list,
  periscope_sentinels_list,
  periscope_events_list,
  periscope_catalog_metadata,
  periscope_catalog_tree,
  periscope_droplet_locate,
  periscope_droplet_residual,
  periscopeTools,
} from '../../src/tools/periscope.js';
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

// ---------------------------------------------------------------------------
// No-arg tools (status, formation_list)
// ---------------------------------------------------------------------------

test('periscope_status: emits PeriscopeStatus query (no vars)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    { data: { periscopeStatus: { tenantId: 't1', rows: [], healthSummary: 'OK' } } },
    recorder,
  );
  try {
    const r = await periscope_status.execute(ctx(), {});
    assert.match(recorder[0]!.body.query, /periscopeStatus/);
    assert.deepEqual(recorder[0]!.body.variables, {});
    assert.deepEqual(
      r as { tenantId: string },
      { tenantId: 't1', rows: [], healthSummary: 'OK' },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('periscope_formation_list: emits PeriscopeFormationList query', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    { data: { periscopeFormationList: [] } },
    recorder,
  );
  try {
    await periscope_formation_list.execute(ctx(), {});
    assert.match(recorder[0]!.body.query, /periscopeFormationList/);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// formation-only tools (describe, lint, audit, reconcile, tier_list,
// catalog_metadata, catalog_tree)
// ---------------------------------------------------------------------------

const formationOnlyTools = [
  { tool: periscope_formation_describe, query: /periscopeFormationDescribe/, response: 'periscopeFormationDescribe' },
  { tool: periscope_formation_lint, query: /periscopeFormationLint/, response: 'periscopeFormationLint' },
  { tool: periscope_audit, query: /periscopeAudit/, response: 'periscopeAudit' },
  { tool: periscope_reconcile, query: /periscopeReconcile/, response: 'periscopeReconcile' },
  { tool: periscope_tier_list, query: /periscopeTierList/, response: 'periscopeTierList' },
  { tool: periscope_catalog_metadata, query: /periscopeCatalogMetadata/, response: 'periscopeCatalogMetadata' },
  { tool: periscope_catalog_tree, query: /periscopeCatalogTree/, response: 'periscopeCatalogTree' },
];

for (const { tool, query, response } of formationOnlyTools) {
  test(`${tool.name}: passes formationId variable`, async () => {
    const recorder: FetchCallRecord[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch({ data: { [response]: { ok: true } } }, recorder);
    try {
      await tool.execute(ctx(), { formation: 'widget' });
      assert.match(recorder[0]!.body.query, query);
      assert.equal(recorder[0]!.body.variables['formationId'], 'widget');
    } finally {
      globalThis.fetch = original;
    }
  });

  test(`${tool.name}: missing formation returns error (no GraphQL call)`, async () => {
    const recorder: FetchCallRecord[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch({ data: {} }, recorder);
    try {
      const r = await tool.execute(ctx(), {});
      assert.deepEqual(r, { error: 'formation required' });
      assert.equal(recorder.length, 0);
    } finally {
      globalThis.fetch = original;
    }
  });
}

// ---------------------------------------------------------------------------
// formation+tier tools (tier_describe, tier_cursor, droplet_residual)
// ---------------------------------------------------------------------------

test('periscope_tier_describe: passes formationId + tier', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    { data: { periscopeTierDescribe: { name: 'stream' } } },
    recorder,
  );
  try {
    await periscope_tier_describe.execute(ctx(), {
      formation: 'widget',
      tier: 'stream',
    });
    assert.equal(recorder[0]!.body.variables['formationId'], 'widget');
    assert.equal(recorder[0]!.body.variables['tier'], 'stream');
  } finally {
    globalThis.fetch = original;
  }
});

test('periscope_tier_cursor: passes formationId + tier', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    { data: { periscopeTierCursor: { cursor: 'abc' } } },
    recorder,
  );
  try {
    await periscope_tier_cursor.execute(ctx(), {
      formation: 'widget',
      tier: 'river',
    });
    assert.match(recorder[0]!.body.query, /periscopeTierCursor/);
    assert.equal(recorder[0]!.body.variables['tier'], 'river');
  } finally {
    globalThis.fetch = original;
  }
});

test('periscope_tier_describe: missing tier returns error', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: {} }, recorder);
  try {
    const r = await periscope_tier_describe.execute(ctx(), {
      formation: 'widget',
    });
    assert.deepEqual(r, { error: 'formation and tier required' });
    assert.equal(recorder.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('periscope_droplet_residual: passes formationId + tier + optional limit', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    { data: { periscopeDropletResidual: { count: 0 } } },
    recorder,
  );
  try {
    // no limit -> not in vars
    await periscope_droplet_residual.execute(ctx(), {
      formation: 'widget',
      tier: 'stream',
    });
    assert.equal(recorder[0]!.body.variables['limit'], undefined);

    // limit > 0 -> included
    await periscope_droplet_residual.execute(ctx(), {
      formation: 'widget',
      tier: 'stream',
      limit: 100,
    });
    assert.equal(recorder[1]!.body.variables['limit'], 100);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// snapshot_list (formation required, optional tier + limit)
// ---------------------------------------------------------------------------

test('periscope_snapshot_list: tier optional, limit optional', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    { data: { periscopeSnapshotList: [] } },
    recorder,
  );
  try {
    // bare formation
    await periscope_snapshot_list.execute(ctx(), { formation: 'widget' });
    assert.equal(recorder[0]!.body.variables['formationId'], 'widget');
    assert.equal(recorder[0]!.body.variables['tier'], undefined);
    assert.equal(recorder[0]!.body.variables['limit'], undefined);

    // with tier + limit
    await periscope_snapshot_list.execute(ctx(), {
      formation: 'widget',
      tier: 'lake',
      limit: 50,
    });
    assert.equal(recorder[1]!.body.variables['tier'], 'lake');
    assert.equal(recorder[1]!.body.variables['limit'], 50);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// snapshot_get (formation + snapshotId)
// ---------------------------------------------------------------------------

test('periscope_snapshot_get: passes formationId + snapshotId', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    { data: { periscopeSnapshotGet: { snapshotId: 's1' } } },
    recorder,
  );
  try {
    await periscope_snapshot_get.execute(ctx(), {
      formation: 'widget',
      snapshotId: 's1',
    });
    assert.equal(recorder[0]!.body.variables['snapshotId'], 's1');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// pool_list (formation + tier required, snapshotId + limit optional)
// ---------------------------------------------------------------------------

test('periscope_pool_list: required + optional vars', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    { data: { periscopePoolList: [] } },
    recorder,
  );
  try {
    await periscope_pool_list.execute(ctx(), {
      formation: 'widget',
      tier: 'stream',
      snapshotId: 'snap-1',
      limit: 10,
    });
    const v = recorder[0]!.body.variables;
    assert.equal(v['formationId'], 'widget');
    assert.equal(v['tier'], 'stream');
    assert.equal(v['snapshotId'], 'snap-1');
    assert.equal(v['limit'], 10);
  } finally {
    globalThis.fetch = original;
  }
});

test('periscope_pool_list: missing tier returns error', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: {} }, recorder);
  try {
    const r = await periscope_pool_list.execute(ctx(), {
      formation: 'widget',
    });
    assert.deepEqual(r, { error: 'formation and tier required' });
    assert.equal(recorder.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// sentinels_list (formation required, tier optional)
// ---------------------------------------------------------------------------

test('periscope_sentinels_list: tier optional', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    { data: { periscopeSentinels: [] } },
    recorder,
  );
  try {
    await periscope_sentinels_list.execute(ctx(), { formation: 'widget' });
    assert.equal(recorder[0]!.body.variables['tier'], undefined);

    await periscope_sentinels_list.execute(ctx(), {
      formation: 'widget',
      tier: 'lake',
    });
    assert.equal(recorder[1]!.body.variables['tier'], 'lake');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// events_list (all args optional)
// ---------------------------------------------------------------------------

test('periscope_events_list: all args optional', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    { data: { periscopeEvents: [] } },
    recorder,
  );
  try {
    // bare call, no vars
    await periscope_events_list.execute(ctx(), {});
    assert.deepEqual(recorder[0]!.body.variables, {});

    // every arg
    await periscope_events_list.execute(ctx(), {
      formation: 'widget',
      tier: 'stream',
      dueOnly: true,
      pendingOnly: false,
    });
    const v = recorder[1]!.body.variables;
    assert.equal(v['formationId'], 'widget');
    assert.equal(v['tier'], 'stream');
    assert.equal(v['dueOnly'], true);
    assert.equal(v['pendingOnly'], false);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// droplet_locate (formation + dropletId)
// ---------------------------------------------------------------------------

test('periscope_droplet_locate: passes formation + dropletId', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        periscopeDropletLocate: {
          formationId: 'widget',
          dropletId: 'd1',
          tiers: [],
          pointer: null,
        },
      },
    },
    recorder,
  );
  try {
    await periscope_droplet_locate.execute(ctx(), {
      formation: 'widget',
      dropletId: 'd1',
    });
    assert.equal(recorder[0]!.body.variables['dropletId'], 'd1');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// Aggregator + metadata parity
// ---------------------------------------------------------------------------

test('periscopeTools: 18 entries in Go-mirroring order', () => {
  assert.equal(periscopeTools.length, 18);
  const names = periscopeTools.map((t) => t.name);
  // First few must match the Go aggregator order verbatim.
  assert.deepEqual(names.slice(0, 6), [
    'periscope_status',
    'periscope_formation_list',
    'periscope_formation_describe',
    'periscope_audit',
    'periscope_reconcile',
    'periscope_tier_list',
  ]);
});

test('periscope tools: every tool is read-only', () => {
  for (const t of periscopeTools) {
    assert.equal(t.minRole, 'read', `${t.name}: minRole=read`);
    assert.ok(!t.modifiesResource, `${t.name}: modifiesResource=false`);
  }
});
