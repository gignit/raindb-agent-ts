// usage.ts -- agent tools for tenant usage events + summary.
//
// Mirrors raindb-phoenix-oc/internal/ai/tools_usage.go::tenantUsageTools.
// 2 tenant-scoped tools (admin *_all variants excluded). Both run
// via the executeSQL GraphQL query against the platform_usage_event
// formation -- mirrors ops/usage.go::UsageList +
// ops/usage.go::UsageSummary.

import { executeSQL } from '../client/sql.js';
import { intArg, stringArg } from '../registry/build.js';
import type { RegisteredTool } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Wire shapes (mirror internal/ops/usage.go)
// ---------------------------------------------------------------------------

export interface UsageEvent {
  timestamp: string;
  service: string;
  dimension: string;
  quantity: string;
  unit: string;
  model: string;
}

export interface UsageSummaryRow {
  service: string;
  dimension: string;
  unit: string;
  events: string;
  total: string;
  firstEvent: string;
  lastEvent: string;
}

// usageDedup: ROW_NUMBER over eventId DESC by ts so we drop
// duplicate events kept around from idempotent retries. Verbatim
// from internal/ops/usage.go::usageDedup.
const USAGE_DEDUP = `(
  SELECT *, ROW_NUMBER() OVER (PARTITION BY eventId ORDER BY ts DESC) AS rn
  FROM entity."platform_usage_event"
) sub`;

// validateUsageIdent guards SQL identifiers passed in the WHERE
// clause. The Go side (ops/usage.go::validateUsageIdent) accepts
// only [A-Za-z0-9_-]+. Empty is allowed (means no filter).
function validateUsageIdent(field: string, value: string): string | null {
  if (value === '') return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return `${field}: invalid identifier (allowed: [A-Za-z0-9_-]+)`;
  }
  return null;
}

function usageWhereClause(service: string, dimension: string): string {
  const parts: string[] = ['rn = 1'];
  if (service !== '') {
    parts.push(`serviceId = '${service}'`);
  }
  if (dimension !== '') {
    parts.push(`dimension = '${dimension}'`);
  }
  return parts.join(' AND ');
}

const DEFAULT_USAGE_LIST_LIMIT = 100;

// ---------------------------------------------------------------------------
// usage_list -- Go ref: tools_usage.go (lines 19-41)
//   + ops/usage.go::UsageList (lines 201-242)
// ---------------------------------------------------------------------------

export const usage_list: RegisteredTool = {
  name: 'usage_list',
  description:
    'List recent usage events for the current tenant (filter by '
    + 'service/dimension). Equivalent CLI: raindb-cli usage list',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      service: { type: 'string', description: 'Optional service filter' },
      dimension: { type: 'string', description: 'Optional dimension filter' },
      limit: { type: 'integer', description: 'Max results (default 100)' },
    },
  },
  async execute(ctx, args) {
    const service = stringArg(args, 'service');
    const dimension = stringArg(args, 'dimension');
    const svcErr = validateUsageIdent('service', service);
    if (svcErr) return { error: svcErr };
    const dimErr = validateUsageIdent('dimension', dimension);
    if (dimErr) return { error: dimErr };
    let limit = intArg(args, 'limit', DEFAULT_USAGE_LIST_LIMIT);
    if (limit <= 0) limit = DEFAULT_USAGE_LIST_LIMIT;
    const where = usageWhereClause(service, dimension);
    const sql = `SELECT
      timestamp,
      serviceId AS service,
      dimension,
      quantity,
      unit,
      json_extract_string(metadata, '$.model') AS model
    FROM ${USAGE_DEDUP}
    WHERE ${where}
    ORDER BY timestamp DESC
    LIMIT ${limit}`;
    // Canonical hyphenated formationId for the executeSQL prelude
    // (server-side LoadFormation). SQL body references the DuckDB
    // view name `entity."platform_usage_event"` (FormationIDSafe,
    // underscored). Both are correct in their layers.
    const result = await executeSQL(sql, 'platform-usage-event', ctx.creds);
    const events: UsageEvent[] = result.rows.map((row) => ({
      timestamp: row[0] ?? '',
      service: row[1] ?? '',
      dimension: row[2] ?? '',
      quantity: row[3] ?? '',
      unit: row[4] ?? '',
      model: row[5] ?? '',
    }));
    return events;
  },
};

// ---------------------------------------------------------------------------
// usage_summary -- Go ref: tools_usage.go (lines 42-60)
//   + ops/usage.go::UsageSummary (lines 245-281)
// ---------------------------------------------------------------------------

export const usage_summary: RegisteredTool = {
  name: 'usage_summary',
  description:
    "Summarize the current tenant's usage by service + dimension. "
    + 'Equivalent CLI: raindb-cli usage summary',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      service: { type: 'string', description: 'Optional service filter' },
    },
  },
  async execute(ctx, args) {
    const service = stringArg(args, 'service');
    const svcErr = validateUsageIdent('service', service);
    if (svcErr) return { error: svcErr };
    const where = usageWhereClause(service, '');
    const sql = `SELECT
      serviceId AS service,
      dimension,
      unit,
      COUNT(*) AS events,
      SUM(quantity) AS total,
      MIN(timestamp) AS first_event,
      MAX(timestamp) AS last_event
    FROM ${USAGE_DEDUP}
    WHERE ${where}
    GROUP BY serviceId, dimension, unit
    ORDER BY serviceId, dimension`;
    // Canonical hyphenated formationId for the executeSQL prelude;
    // SQL body uses entity."platform_usage_event" (DuckDB view name).
    const result = await executeSQL(sql, 'platform-usage-event', ctx.creds);
    const rows: UsageSummaryRow[] = result.rows.map((row) => ({
      service: row[0] ?? '',
      dimension: row[1] ?? '',
      unit: row[2] ?? '',
      events: row[3] ?? '',
      total: row[4] ?? '',
      firstEvent: row[5] ?? '',
      lastEvent: row[6] ?? '',
    }));
    return rows;
  },
};

export const usageTools: RegisteredTool[] = [usage_list, usage_summary];
