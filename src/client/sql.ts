// sql.ts -- thin client wrapper for raindb's executeSQL GraphQL
// query. Used by the SQL-flavored agent tools (usage_list,
// usage_summary, llm_usage_report_summary, sql_execute,
// vector_search ... when those land).
//
// Keeps the same wire shape so a query that runs through raindb-cli's
// `raindb-cli sql` runs identically through this surface.

import { executeGraphQL } from './graphql.js';
import type { AgentHost } from '../host/types.js';
import type { GraphQLOptions } from '../registry/types.js';

// Freshness bridge. The SQL plane is eventually-consistent: rows
// reflect the last committed periscope snapshot, not necessarily
// the newest writes. When a query carries a formationId hint AND
// the formation declares a "by-update" index, the RainDB API returns a
// per-formation freshness bookmark so a caller can detect drift and
// harvest late arrivals. See RainDB schema.graphqls SQLResult
// / FormationLatest for the full contract.
export type FreshnessStatus =
  | 'CURRENT'
  | 'BEHIND'
  | 'UNKNOWN'
  | 'UNAVAILABLE';

export interface FormationLatest {
  formationId: string;
  // lex-max dropletId reflected in the SQL view's snapshot.
  snapshotDropletId?: string;
  // pointer-index key for snapshotDropletId; pass as `after` to
  // droplet_since / listKeys when harvesting the tail.
  snapshotKey?: string;
  // Commit time of the snapshot. GraphQL Time! -> Unix-MILLISECONDS
  // NUMBER, never a string.
  snapshotAt?: number;
  // lex-max dropletId in the formation right now (by-update latest).
  currentDropletId?: string;
  currentKey?: string;
  // Tenant-scoped by-update index prefix for the ASC forward-scan
  // harvest; always ends with a trailing slash. Empty when the
  // formation declares no by-update index (freshness disabled).
  indexPrefix?: string;
  // Server-computed drift verdict. Read this DIRECTLY to decide
  // whether to harvest -- do not re-derive from the cursors.
  freshnessStatus?: FreshnessStatus;
}

export interface SQLResult {
  columns: string[];
  rows: string[][];
  rowCount: number;
  durationMs: number;
  // True when the executor hit its row-count ceiling before the
  // query exhausted its result set (silently cut off). Re-query
  // with a higher limit or paginate.
  truncated?: boolean;
  // Per-formation freshness bookmark(s). Populated when the query
  // had a formationId hint and the formation declares by-update.
  latest?: FormationLatest[];
}

interface ExecuteSQLResponse {
  executeSQL: {
    columns: string[];
    rows: unknown[][] | string[][] | string[];
    rowCount: number;
    durationMs: number;
    truncated?: boolean;
    latest?: FormationLatest[] | null;
  };
}

const EXECUTE_SQL_QUERY = `
  query ExecuteSQL($input: SQLInput!) {
    executeSQL(input: $input) {
      columns
      rows
      rowCount
      durationMs
      truncated
      latest {
        formationId
        snapshotDropletId
        snapshotKey
        snapshotAt
        currentDropletId
        currentKey
        indexPrefix
        freshnessStatus
      }
    }
  }
`;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Per-query view-preparation planner override (mirrors the SDL
 * SQLInput.planStrategy field). Null/omitted uses each formation's
 * default; 'range' / 'scan' force the planner.
 */
export type PlanStrategy = 'range' | 'scan';

/** Optional knobs for executeSQL. Kept out of the positional
 * argument list so existing callers (usage.ts, llm.ts, query.ts)
 * stay source-compatible. */
export interface ExecuteSQLOptions {
  planStrategy?: PlanStrategy;
}

/**
 * Execute a SQL query through the RainDB API. When `formationId` is
 * passed, the RainDB API scopes the query context to that formation's
 * entity view; when empty, it runs against the tenant's full entity
 * dataset.
 *
 * The optional `host` parameter routes the GraphQL HTTP call
 * through an injected transport (see executeGraphQL docstring).
 *
 * The returned SQLResult carries the eventual-consistency freshness
 * bookmark (`latest`) and `truncated` flag when the RainDB API provides
 * them -- see the SQLResult type doc.
 */
export async function executeSQL(
  query: string,
  formationId: string,
  creds: GraphQLOptions,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  host?: AgentHost,
  options?: ExecuteSQLOptions,
): Promise<SQLResult> {
  const input: Record<string, unknown> = {
    sql: query,
    timeoutMs,
  };
  if (formationId) input['formationId'] = formationId;
  if (options?.planStrategy) input['planStrategy'] = options.planStrategy;
  const data = await executeGraphQL<ExecuteSQLResponse>(
    EXECUTE_SQL_QUERY,
    { input },
    creds,
    host,
  );
  // The RainDB API returns rows as JSON-encoded string arrays per row
  // when the GraphQL surface marshals the SQLResult value list.
  // Normalize to string[][].
  const rows: string[][] = (data.executeSQL.rows ?? []).map((row) => {
    if (Array.isArray(row)) {
      return (row as unknown[]).map((cell) =>
        cell === null || cell === undefined ? '' : String(cell),
      );
    }
    if (typeof row === 'string') {
      // Defensive: GraphQL JSON scalar may serialize each row as
      // a JSON string. Parse + project.
      try {
        const parsed = JSON.parse(row);
        if (Array.isArray(parsed)) {
          return parsed.map((cell) =>
            cell === null || cell === undefined ? '' : String(cell),
          );
        }
      } catch {
        // fall through; treat as single-cell row.
      }
      return [row];
    }
    return [];
  });
  const result: SQLResult = {
    columns: data.executeSQL.columns,
    rows,
    rowCount: data.executeSQL.rowCount,
    durationMs: data.executeSQL.durationMs,
  };
  if (typeof data.executeSQL.truncated === 'boolean') {
    result.truncated = data.executeSQL.truncated;
  }
  if (data.executeSQL.latest && data.executeSQL.latest.length > 0) {
    result.latest = data.executeSQL.latest;
  }
  return result;
}

/**
 * Project a SQL row (string array, columns aligned by index) to a
 * named-field record.
 */
export function sqlRowToColumns(
  row: string[],
  columns: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < columns.length; i += 1) {
    out[columns[i]!] = row[i] ?? '';
  }
  return out;
}
