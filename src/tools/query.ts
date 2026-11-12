// query.ts -- agent tools for ad-hoc SQL + vector search.
//
// 2 tools, both read-only:
//
//   sql_execute   -- arbitrary DuckDB SQL through executeSQL /
//                    queryEntities, with a SELECT-only guard because
//                    the agent should not be writing data via SQL.
//   vector_search -- semantic search over an embedding-enabled
//                    formation.

import { executeGraphQL } from '../client/graphql.js';
import { executeSQL, type SQLResult } from '../client/sql.js';
import {
  boolArg,
  intArg,
  objectArg,
  stringArg,
} from '../registry/build.js';
import type { RegisteredTool } from '../registry/types.js';

// ---------------------------------------------------------------------------
// SELECT-only guard. The agent surface enforces SELECT-only
// client-side regardless of the caller's role -- writes go through
// tool primitives (droplet_*, catalog_*) which give per-row
// validation + audit.
// ---------------------------------------------------------------------------

const FORBIDDEN_SQL_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER',
  'TRUNCATE', 'GRANT', 'REVOKE', 'ATTACH', 'DETACH', 'COPY',
  'CALL', 'EXEC', 'EXECUTE', 'PRAGMA',
];

/**
 * Strip line/block comments (--, /* ... *\/), trim, then verify
 * the first non-whitespace token is SELECT (or WITH for CTEs).
 * Reject any forbidden DDL/DML keyword anywhere in the query --
 * a naive parser, but defense-in-depth.
 */
function validateSelectOnly(rawQuery: string): string | null {
  if (rawQuery.trim() === '') {
    return 'query required';
  }
  // Strip block comments. Use [\s\S] instead of dotall so this
  // works on the package's TS target.
  let q = rawQuery.replace(/\/\*[\s\S]*?\*\//g, '');
  // Strip line comments (-- to end of line).
  q = q.replace(/--[^\n]*/g, '');
  q = q.trim();
  if (q === '') {
    return 'query required (only comments)';
  }
  const upper = q.toUpperCase();
  if (!/^(SELECT|WITH)\b/.test(upper)) {
    return 'query must start with SELECT or WITH (read-only); writes go through droplet_* or catalog_* tools';
  }
  for (const kw of FORBIDDEN_SQL_KEYWORDS) {
    // Match the keyword as a standalone token.
    const re = new RegExp(`\\b${kw}\\b`);
    if (re.test(upper)) {
      return `query contains forbidden keyword: ${kw}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// sql_execute
//
// The `formation` arg controls whether the RainDB API uses
// queryEntities (formation-scoped) or executeSQL (tenant-wide);
// both run through the same DuckDB executor on the server side.
// ---------------------------------------------------------------------------

export const sql_execute: RegisteredTool = {
  name: 'sql_execute',
  description:
    "Execute a SQL query against the current tenant's formation data via "
    + "DuckDB. Pass optional 'formation' to scope to one formation via "
    + 'QueryEntities. SELECT/WITH only -- writes go through droplet_* or '
    + 'catalog_* tools. The SQL plane is EVENTUALLY CONSISTENT: rows '
    + 'reflect the last committed periscope snapshot, not necessarily the '
    + "newest writes. When 'formation' is set the result carries a "
    + '`latest` freshness bookmark: latest[].freshnessStatus BEHIND means '
    + 'the snapshot predates the newest writes. Only when the answer must '
    + 'include those writes, optionally fetch them with droplet_since '
    + '(after=latest[].snapshotKey) and merge (newest wins). `truncated` '
    + 'is true when the row ceiling cut the result off. Optional '
    + "'planStrategy' (range|scan) overrides the view-preparation planner. "
    + 'Equivalent CLI: raindb-cli sql',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      formation: {
        type: 'string',
        description:
          'Optional formation scope. Required to receive the freshness '
          + 'bookmark (latest).',
      },
      planStrategy: {
        type: 'string',
        enum: ['range', 'scan'],
        description:
          'Optional view-preparation planner override; omitted uses the '
          + "formation's default.",
      },
    },
    required: ['query'],
  },
  async execute(ctx, args): Promise<SQLResult | { error: string }> {
    const query = stringArg(args, 'query');
    const guardErr = validateSelectOnly(query);
    if (guardErr) return { error: guardErr };
    const formation = stringArg(args, 'formation');
    const planRaw = stringArg(args, 'planStrategy').toLowerCase();
    const planStrategy =
      planRaw === 'range' || planRaw === 'scan' ? planRaw : undefined;
    return executeSQL(query, formation, ctx.creds, undefined, ctx.host, {
      planStrategy,
    });
  },
};

// ---------------------------------------------------------------------------
// vector_search
// ---------------------------------------------------------------------------

interface VectorSearchHitCitation {
  page?: number;
  section?: string;
  lineRange?: number[];
}

export interface VectorSearchHit {
  key: string;
  score: number;
  text?: string;
  metadata?: Record<string, unknown>;
  retrievalSources?: string[];
  retrievalRank?: Record<string, unknown>;
  scoreBreakdown?: Record<string, unknown>;
  confidence?: string;
  citation?: VectorSearchHitCitation;
}

interface VectorSearchTrace {
  traceId: string;
  legDurations?: Record<string, unknown>;
  legHitCounts?: Record<string, unknown>;
  fusionMethod?: string;
  degradations?: string[];
  totalCandidates?: number;
}

export interface VectorSearchResult {
  hits: VectorSearchHit[];
  model?: string;
  trace?: VectorSearchTrace;
}

const VECTOR_SEARCH_QUERY = `
  query VectorSearch($input: VectorSearchInput!) {
    vectorSearch(input: $input) {
      hits {
        key
        score
        text
        metadata
        retrievalSources
        retrievalRank
        scoreBreakdown
        confidence
        citation {
          page
          section
          lineRange
        }
      }
      model
      trace {
        traceId
        legDurations
        legHitCounts
        fusionMethod
        degradations
        totalCandidates
      }
    }
  }
`;

export const vector_search: RegisteredTool = {
  name: 'vector_search',
  description:
    "Semantic vector search over a formation's embedded content. "
    + 'Equivalent CLI: raindb-cli search',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      model: { type: 'string', description: 'Embedding model ID' },
      query: { type: 'string' },
      topK: { type: 'integer', description: 'Max hits (default 10)' },
      hybrid: {
        type: 'boolean',
        description: 'Enable hybrid BM25+vector (default false)',
      },
      filter: {
        type: 'object',
        description:
          'Metadata filter applied at the vector index. Keys must match '
          + "the formation's vectorConfig.metadataFields. Example: "
          + '{"documentId": "<uuid>"}',
      },
    },
    required: ['formation', 'model', 'query'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const model = stringArg(args, 'model');
    const query = stringArg(args, 'query');
    if (!formation || !model || !query) {
      return { error: 'formation, model, query required' };
    }
    const input: Record<string, unknown> = {
      formationId: formation,
      query,
      model,
      topK: intArg(args, 'topK', 10),
      hybrid: boolArg(args, 'hybrid', false),
    };
    const filter = objectArg(args, 'filter');
    if (filter) input['filter'] = filter;
    const data = await executeGraphQL<{ vectorSearch: VectorSearchResult | null }>(
      VECTOR_SEARCH_QUERY,
      { input },
      ctx.creds,
      ctx.host,
    );
    return data.vectorSearch ?? { hits: [] };
  },
};

export const queryTools: RegisteredTool[] = [sql_execute, vector_search];
