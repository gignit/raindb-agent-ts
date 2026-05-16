// llm.ts -- agent tools for LLM provider/model registry +
// per-tenant usage reporting.
//
// Mirrors raindb-phoenix-oc/internal/ai/tools_llm.go::tenantLLMTools.
// 3 tenant-scoped tools (admin reconcile/vendor variants excluded).
//
//   llm_provider_list -- list platform-llm-provider entries
//   llm_model_list    -- list platform-llm-model entries
//   llm_usage_report_summary -- aggregated cost report

import { executeGraphQL } from '../client/graphql.js';
import { executeSQL } from '../client/sql.js';
import { intArg } from '../registry/build.js';
import type { RegisteredTool } from '../registry/types.js';

// Canonical hyphenated formation ids -- the public agent-facing contract.
// raindb-api stores these formations at
//   indexes/platform-llm-provider/by-id/...
//   indexes/platform-llm-model/by-id/...
// The DuckDB-internal underscored form ("platform_llm_model") is a
// server-side translation handled by formation.FormationIDSafe; clients
// must NEVER send the underscored form -- a listKeys against
// `indexes/platform_llm_model/by-id/` returns zero results because
// nothing is stored there.
const PROVIDER_FORMATION = 'platform-llm-provider';
const MODEL_FORMATION = 'platform-llm-model';

// Both list ops walk the by-id index and project each pointer to
// the underlying droplet. We use listKeys on the by-id prefix +
// readLatest on each match, mirroring ops/llm_registry.go::
// LLMProviderList + LLMModelList exactly.

const LIST_KEYS_QUERY = `
  query ListKeys($input: ListKeysInput!) {
    listKeys(input: $input) {
      keys {
        key
      }
      nextCursor
      hasMore
    }
  }
`;

const READ_LATEST_QUERY = `
  query ReadLatest($input: ReadLatestInput!) {
    readLatest(input: $input) {
      payload
    }
  }
`;

interface ListKeysResponse {
  listKeys: {
    keys: Array<{ key: string }>;
    nextCursor?: string | null;
    hasMore: boolean;
  };
}

interface ReadLatestPayloadResponse {
  readLatest: { payload: Record<string, unknown> | null } | null;
}

/**
 * List all keys under `prefix` (paged), then derive the entity id
 * from each key + read the latest droplet through the by-id-latest
 * index. Returns the raw payloads (typed minimally; the Go side
 * unmarshals into ProviderConfig / Model structs but keeping it
 * loose here lets the model see the full shape).
 *
 * Mirrors the ops/llm_registry.go pattern verbatim:
 *   keys = ListAllKeys(prefix=indexes/<formation>/by-id/)
 *   for each key matching .../by-id/<entityId>/latest.json:
 *     droplet = ReadLatest(formation, "by-id-latest", entityId)
 *     unmarshal(droplet.Payload)
 */
async function listFormationEntities(
  formationId: string,
  creds: { apiKey?: string; endpoint?: string },
  host: import('../host/types.js').AgentHost | undefined,
): Promise<Record<string, unknown>[]> {
  const prefix = `indexes/${formationId}/by-id/`;
  const allKeys: string[] = [];
  let cursor: string | undefined;
  while (true) {
    const input: Record<string, unknown> = { prefix, pageSize: 1000 };
    if (cursor) input['cursor'] = cursor;
    const data = await executeGraphQL<ListKeysResponse>(
      LIST_KEYS_QUERY,
      { input },
      creds,
    );
    for (const k of data.listKeys.keys ?? []) allKeys.push(k.key);
    if (!data.listKeys.hasMore || !data.listKeys.nextCursor) break;
    cursor = data.listKeys.nextCursor;
  }

  // Project keys -> entity ids. Mirror Go llm_registry.go:34-39
  // (provider) and :60-76 (model -- which supports nested ids
  // like 'fdn/sonnet' so it joins parts after by-id).
  const ids = new Set<string>();
  for (const key of allKeys) {
    const parts = key.split('/');
    if (parts[parts.length - 1] !== 'latest.json') continue;
    const byIdIdx = parts.indexOf('by-id');
    if (byIdIdx < 0 || byIdIdx >= parts.length - 2) continue;
    const id = parts.slice(byIdIdx + 1, parts.length - 1).join('/');
    if (id) ids.add(id);
  }

  const out: Record<string, unknown>[] = [];
  for (const id of ids) {
    try {
      const data = await executeGraphQL<ReadLatestPayloadResponse>(
        READ_LATEST_QUERY,
        {
          input: {
            formationId,
            indexId: 'by-id-latest',
            scopeValue: id,
          },
        },
        creds,
      );
      const payload = data.readLatest?.payload;
      if (payload) out.push(payload);
    } catch {
      // Mirror Go behavior: skip individual read failures rather
      // than aborting the whole list (lines 41-46 + 78-83).
      continue;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// llm_provider_list -- Go ref: tools_llm.go (lines 44-55)
//   + ops/llm_registry.go::LLMProviderList (lines 28-51)
// ---------------------------------------------------------------------------

export const llm_provider_list: RegisteredTool = {
  name: 'llm_provider_list',
  description:
    'List every LLM provider available to this tenant (entries from '
    + 'the platform-llm-provider formation). Equivalent CLI: '
    + 'raindb-cli llm provider list',
  minRole: 'read',
  parameters: { type: 'object' },
  async execute(ctx) {
    return listFormationEntities(PROVIDER_FORMATION, ctx.creds, ctx.host);
  },
};

// ---------------------------------------------------------------------------
// llm_model_list -- Go ref: tools_llm.go (lines 56-67)
//   + ops/llm_registry.go::LLMModelList (lines 54-88)
// ---------------------------------------------------------------------------

export const llm_model_list: RegisteredTool = {
  name: 'llm_model_list',
  description:
    'List every LLM model available to this tenant (entries from '
    + 'the platform-llm-model formation). Equivalent CLI: '
    + 'raindb-cli llm model list',
  minRole: 'read',
  parameters: { type: 'object' },
  async execute(ctx) {
    return listFormationEntities(MODEL_FORMATION, ctx.creds, ctx.host);
  },
};

// ---------------------------------------------------------------------------
// llm_usage_report_summary -- Go ref: tools_llm.go (lines 68-87)
//   + ops/host.go::LLMUsageReportSummary (lines 193-239)
//
// The Go op builds a SQL string (rolling up usage events grouped by
// date/model/provider/dimension) and runs it through the same
// executeSQL surface usage_list uses. We mirror the SQL string
// verbatim.
// ---------------------------------------------------------------------------

export interface LLMUsageReportRow {
  date: string;
  model: string;
  provider: string;
  dimension: string;
  requests: string;
  totalTokens: string;
  platformCost: string;
  vendorCost: string;
}

const USAGE_DEDUP = `(
  SELECT *, ROW_NUMBER() OVER (PARTITION BY eventId ORDER BY ts DESC) AS rn
  FROM entity."platform_usage_event"
) sub`;

export const llm_usage_report_summary: RegisteredTool = {
  name: 'llm_usage_report_summary',
  description:
    "Aggregate THIS TENANT's LLM usage (requests, tokens, platform cost, "
    + 'vendor cost) grouped by date/model/provider/dimension. Reads from '
    + 'entity.platform_usage_event for the calling tenant -- never '
    + "cross-tenant. Use this to answer 'what did I spend this month?' or "
    + "'which model is consuming the most tokens?'. Equivalent CLI: "
    + 'raindb-cli llm usage-report summary',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        description: 'Lookback window in days (0 = all time, default 0)',
      },
    },
  },
  async execute(ctx, args) {
    const days = Math.max(0, intArg(args, 'days', 0));
    let where = 'rn = 1';
    if (days > 0) {
      where = `rn = 1 AND CAST(timestamp AS TIMESTAMP) >= CURRENT_DATE - INTERVAL '${days}' DAY`;
    }
    const sql = `SELECT
      CAST(timestamp AS DATE) AS date,
      json_extract_string(metadata, '$.model') AS model,
      json_extract_string(metadata, '$.provider') AS provider,
      dimension,
      COUNT(*) AS requests,
      SUM(quantity) AS total_tokens,
      SUM(CAST(json_extract(metadata, '$.totalCost') AS DOUBLE)) AS platform_cost,
      SUM(CAST(json_extract(metadata, '$.vendorCost') AS DOUBLE)) AS vendor_cost
    FROM ${USAGE_DEDUP}
    WHERE ${where}
    GROUP BY date, model, provider, dimension
    ORDER BY date DESC, platform_cost DESC`;
    // Canonical hyphenated formationId for the executeSQL prelude
    // (server-side LoadFormation expects canonical). The SQL body
    // above references `entity."platform_usage_event"` which is the
    // DuckDB view name (= FormationIDSafe, underscored). Both are
    // correct in their respective layers.
    const result = await executeSQL(sql, 'platform-usage-event', ctx.creds, undefined, ctx.host);
    const rows: LLMUsageReportRow[] = result.rows.map((row) => ({
      date: row[0] ?? '',
      model: row[1] ?? '',
      provider: row[2] ?? '',
      dimension: row[3] ?? '',
      requests: row[4] ?? '',
      totalTokens: row[5] ?? '',
      platformCost: row[6] ?? '',
      vendorCost: row[7] ?? '',
    }));
    return rows;
  },
};

export const llmTools: RegisteredTool[] = [
  llm_provider_list,
  llm_model_list,
  llm_usage_report_summary,
];
