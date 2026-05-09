// sql.ts -- thin client wrapper for raindb's executeSQL GraphQL
// query. Used by the SQL-flavored agent tools (usage_list,
// usage_summary, llm_usage_report_summary, sql_execute,
// vector_search ... when those land).
//
// Mirrors internal/ops/sql.go::ExecuteSQL +
// internal/ops/sql.go::ExecuteSQLForFormation. The TS port keeps
// the same wire shape so a query that runs through raindb-cli's
// `raindb-cli sql` runs identically through this surface.

import { executeGraphQL } from './graphql.js';
import type { GraphQLOptions } from '../registry/types.js';

export interface SQLResult {
  columns: string[];
  rows: string[][];
  rowCount: number;
  durationMs: number;
}

interface ExecuteSQLResponse {
  executeSQL: {
    columns: string[];
    rows: unknown[][] | string[][] | string[];
    rowCount: number;
    durationMs: number;
  };
}

const EXECUTE_SQL_QUERY = `
  query ExecuteSQL($input: SQLInput!) {
    executeSQL(input: $input) {
      columns
      rows
      rowCount
      durationMs
    }
  }
`;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Execute a SQL query through raindb-api. When `formationId` is
 * passed, raindb-api scopes the duckdb context to that formation's
 * entity view (mirrors the Go side's QueryEntities path); when
 * empty, it runs against the tenant's full entity dataset.
 */
export async function executeSQL(
  query: string,
  formationId: string,
  creds: GraphQLOptions,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<SQLResult> {
  const input: Record<string, unknown> = {
    sql: query,
    timeoutMs,
  };
  if (formationId) input['formationId'] = formationId;
  const data = await executeGraphQL<ExecuteSQLResponse>(
    EXECUTE_SQL_QUERY,
    { input },
    creds,
  );
  // raindb-api returns rows as JSON-encoded string arrays per row
  // when the GraphQL surface marshals the SQLResult value list.
  // Normalize to string[][] -- ops/sql.go::buildSQLResult does the
  // same shape projection on the Go side.
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
  return {
    columns: data.executeSQL.columns,
    rows,
    rowCount: data.executeSQL.rowCount,
    durationMs: data.executeSQL.durationMs,
  };
}

/**
 * Project a SQL row (string array, columns aligned by index) to a
 * named-field record. Mirrors ops/usage.go::sqlRowToColumns.
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
