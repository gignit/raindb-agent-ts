// usage_llm.test.ts -- usage + llm tools (both run via executeSQL).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { usage_list, usage_summary } from '../../src/tools/usage.js';
import {
  llm_provider_list,
  llm_model_list,
  llm_usage_report_summary,
} from '../../src/tools/llm.js';
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

// ---------------------------------------------------------------------------
// usage_list
// ---------------------------------------------------------------------------

test('usage_list: emits executeSQL with formationId scope', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        executeSQL: {
          columns: ['timestamp', 'service', 'dimension', 'quantity', 'unit', 'model'],
          rows: [
            { timestamp: '2026-05-09T00:00:00Z', service: 'llm', dimension: 'tokens', quantity: '1000', unit: 'tokens', model: 'gpt-4o' },
          ],
          rowCount: 1,
          durationMs: 12,
        },
      },
    },
    recorder,
  );

  try {
    const r = await usage_list.execute(ctx(), { service: 'llm', limit: 50 });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    // Canonical hyphenated formationId for the executeSQL prelude
    // (server-side LoadFormation expects canonical). SQL body uses
    // entity."platform_usage_event" which is the DuckDB view name
    // (= FormationIDSafe, underscored translation).
    assert.equal(input['formationId'], 'platform-usage-event');
    const sql = String(input['sql']);
    assert.match(sql, /SELECT/);
    assert.match(sql, /serviceId = 'llm'/);
    assert.match(sql, /LIMIT 50/);
    const events = r as Array<{ service: string; model: string }>;
    assert.equal(events[0]!.service, 'llm');
    assert.equal(events[0]!.model, 'gpt-4o');
  } finally {
    globalThis.fetch = original;
  }
});

test('usage_list: rejects invalid identifier characters', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ data: {} }, recorder);

  try {
    const r = await usage_list.execute(ctx(), {
      service: "llm'; DROP TABLE x; --",
    });
    assert.match((r as { error: string }).error, /service: invalid identifier/);
    assert.equal(recorder.length, 0, 'no SQL injected');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// usage_summary
// ---------------------------------------------------------------------------

test('usage_summary: emits executeSQL with GROUP BY service+dimension', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        executeSQL: {
          columns: ['service', 'dimension', 'unit', 'events', 'total', 'first_event', 'last_event'],
          rows: [
            { service: 'llm', dimension: 'tokens', unit: 'tokens', events: '100', total: '50000', first_event: '2026-04-01', last_event: '2026-05-01' },
          ],
          rowCount: 1,
          durationMs: 8,
        },
      },
    },
    recorder,
  );

  try {
    const r = await usage_summary.execute(ctx(), {});
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    const sql = String(input['sql']);
    assert.match(sql, /GROUP BY serviceId, dimension, unit/);
    const rows = r as Array<{ service: string; events: string }>;
    assert.equal(rows[0]!.service, 'llm');
    assert.equal(rows[0]!.events, '100');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// llm_provider_list / llm_model_list
// ---------------------------------------------------------------------------

test('llm_provider_list: lists by-id keys + reads each pointer', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [
      // 1st call: listKeys (single page, 2 entries)
      {
        data: {
          listKeys: {
            keys: [
              { key: 'tenants/x/indexes/platform_llm_provider/by-id/openai/latest.json' },
              { key: 'tenants/x/indexes/platform_llm_provider/by-id/anthropic/latest.json' },
            ],
            nextCursor: null,
            hasMore: false,
          },
        },
      },
      // 2nd call: readLatest for openai
      { data: { readLatest: { payload: { providerId: 'openai', name: 'OpenAI' } } } },
      // 3rd call: readLatest for anthropic
      { data: { readLatest: { payload: { providerId: 'anthropic', name: 'Anthropic' } } } },
    ],
    recorder,
  );

  try {
    const r = await llm_provider_list.execute(ctx(), {});
    assert.equal(recorder.length, 3);
    const providers = r as Array<{ providerId: string; name: string }>;
    assert.equal(providers.length, 2);
    // Order in the Set iteration matches insertion order; should be openai, anthropic.
    assert.equal(providers[0]!.providerId, 'openai');
    assert.equal(providers[1]!.providerId, 'anthropic');
  } finally {
    globalThis.fetch = original;
  }
});

test('llm_model_list: handles nested ids (e.g. fdn/sonnet)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [
      {
        data: {
          listKeys: {
            keys: [
              { key: 'tenants/x/indexes/platform-llm-model/by-id/fdn/sonnet/latest.json' },
              { key: 'tenants/x/indexes/platform-llm-model/by-id/fdn/embed/latest.json' },
            ],
            nextCursor: null,
            hasMore: false,
          },
        },
      },
      { data: { readLatest: { payload: { modelId: 'fdn/sonnet', capabilities: ['chat'] } } } },
      { data: { readLatest: { payload: { modelId: 'fdn/embed', capabilities: ['embedding'] } } } },
    ],
    recorder,
  );

  try {
    const r = await llm_model_list.execute(ctx(), {});
    const models = r as Array<{ modelId: string }>;
    assert.equal(models.length, 2);
    assert.equal(models[0]!.modelId, 'fdn/sonnet');
    assert.equal(models[1]!.modelId, 'fdn/embed');
    // Verify the readLatest scopeValue is the joined nested id.
    const readLatestCall1 = recorder[1]!.body.variables['input'] as Record<string, string>;
    assert.equal(readLatestCall1['scopeValue'], 'fdn/sonnet');
  } finally {
    globalThis.fetch = original;
  }
});

test('llm_model_list: skips individual read failures (does not abort)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetchSequence(
    [
      {
        data: {
          listKeys: {
            keys: [
              { key: 'indexes/platform-llm-model/by-id/good/latest.json' },
              { key: 'indexes/platform-llm-model/by-id/bad/latest.json' },
              { key: 'indexes/platform-llm-model/by-id/also-good/latest.json' },
            ],
            nextCursor: null,
            hasMore: false,
          },
        },
      },
      { data: { readLatest: { payload: { modelId: 'good' } } } },
      { errors: [{ message: 'simulated read failure' }] },
      { data: { readLatest: { payload: { modelId: 'also-good' } } } },
    ],
    recorder,
  );

  try {
    const r = await llm_model_list.execute(ctx(), {});
    const models = r as Array<{ modelId: string }>;
    assert.equal(models.length, 2, 'failure was skipped, not aborted');
    assert.deepEqual(
      models.map((m) => m.modelId).sort(),
      ['also-good', 'good'],
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// llm_usage_report_summary
// ---------------------------------------------------------------------------

test('llm_usage_report_summary: SQL has GROUP BY date/model/provider/dimension', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        executeSQL: {
          columns: ['date', 'model', 'provider', 'dimension', 'requests', 'total_tokens', 'platform_cost', 'vendor_cost'],
          rows: [
            { date: '2026-05-01', model: 'gpt-4o', provider: 'openai', dimension: 'tokens', requests: '50', total_tokens: '50000', platform_cost: '0.5', vendor_cost: '0.3' },
          ],
          rowCount: 1,
          durationMs: 10,
        },
      },
    },
    recorder,
  );

  try {
    const r = await llm_usage_report_summary.execute(ctx(), { days: 30 });
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    const sql = String(input['sql']);
    assert.match(sql, /GROUP BY date, model, provider, dimension/);
    assert.match(sql, /CURRENT_DATE - INTERVAL '30' DAY/);
    const rows = r as Array<{ date: string; platformCost: string }>;
    assert.equal(rows[0]!.date, '2026-05-01');
    assert.equal(rows[0]!.platformCost, '0.5');
  } finally {
    globalThis.fetch = original;
  }
});

test('llm_usage_report_summary: days=0 means all-time (no date filter)', async () => {
  const recorder: FetchCallRecord[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(
    {
      data: {
        executeSQL: {
          columns: [],
          rows: [],
          rowCount: 0,
          durationMs: 1,
        },
      },
    },
    recorder,
  );

  try {
    await llm_usage_report_summary.execute(ctx(), {});
    const input = recorder[0]!.body.variables['input'] as Record<string, unknown>;
    const sql = String(input['sql']);
    assert.doesNotMatch(sql, /CURRENT_DATE/);
    assert.match(sql, /WHERE rn = 1\s/);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// Metadata parity
// ---------------------------------------------------------------------------

test('usage + llm tools: metadata matches the tenant tool spec', () => {
  assert.equal(usage_list.minRole, 'read');
  assert.ok(!usage_list.modifiesResource);
  assert.equal(usage_summary.minRole, 'read');

  assert.equal(llm_provider_list.minRole, 'read');
  assert.equal(llm_model_list.minRole, 'read');
  assert.equal(llm_usage_report_summary.minRole, 'read');
});
