// index_page.ts -- agent tool for cursor-paginated index reads
// (asc or desc) backed by the RainDB API ListKeys GraphQL surface.
//
// The canonical primitive for "newest-first page" and
// "polling-for-new" patterns on ANY pointer index, regardless of
// the underlying entity domain. See docs/RAINDB_PATTERNS.md
// "Newest-First Lists + Polling Updates (Reverse-Index Chain)" for
// when to enable orderByDesc:true and how the two-cursor pattern
// works end-to-end.
//
// Modes:
//   - 'desc' (default): newest-first via the chain mirror at
//     <indexName>.desc/. Requires orderByDesc:true on the index;
//     when absent the server returns ErrChainNotEnabled.
//   - 'asc': oldest-first via the live pointer prefix. Works on any
//     pointer index. Used for polling: pass the prior
//     forwardCursor to fetch items newer than the cursor.
//
// Two-cursor response shape (per RAINDB_PATTERNS.md):
//   - items:         the page of entity payloads (with dropletId + ts)
//   - backCursor:    oldest item's scope key; pass back as cursor
//                    with mode=desc to fetch older items
//   - forwardCursor: newest item's scope key; pass back as cursor
//                    with mode=asc to poll for new arrivals
//   - hasMore:       true when more items exist in the same
//                    direction
//
// Partitioned vs global timelines: pass partition for partitioned
// indexes (e.g. conversationId for fdn-chat-messages/by-session,
// authorId for an author-feed index). Omit for global timelines
// (e.g. a recent-documents-across-tenant index).

import { executeGraphQL } from '../client/graphql.js';
import { intArg, stringArg } from '../registry/build.js';
import type { RegisteredTool, ToolArgs } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface KeyEntry {
  key: string;
  size?: number;
  // GraphQL KeyEntry.lastModified is the Time! scalar, which
  // serializes as a Unix-milliseconds number over the wire.
  lastModified?: number;
  etag?: string;
}

interface KeyPage {
  keys: KeyEntry[];
  nextCursor?: string | null;
  hasMore: boolean;
  totalCount?: number;
}

interface DropletPayload {
  dropletId: string;
  scopeValue: string;
  ts: number;
  payload: Record<string, unknown>;
}

export interface IndexPageResult {
  items: Record<string, unknown>[];
  hasMore: boolean;
  mode: 'asc' | 'desc';
  backCursor: string | null;
  forwardCursor: string | null;
  total?: number;
}

// ---------------------------------------------------------------------------
// GraphQL constants
// ---------------------------------------------------------------------------

const LIST_KEYS_QUERY = `
  query ListKeys($input: ListKeysInput!) {
    listKeys(input: $input) {
      keys { key }
      nextCursor
      hasMore
      totalCount
    }
  }
`;

const READ_LATEST_QUERY = `
  query ReadLatest($input: ReadLatestInput!) {
    readLatest(input: $input) {
      dropletId
      ts
      payload
    }
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the scope-key segment from a pointer-index key. Pointer
 * index keys end in /<scopeKey>/latest.json by convention (the
 * formation template's last variable). Returns null when the key
 * doesn't match the expected shape (caller skips it).
 */
function scopeKeyFromPointerKey(key: string): string | null {
  if (!key.endsWith('/latest.json')) return null;
  const parts = key.split('/');
  if (parts.length < 2) return null;
  const scope = parts[parts.length - 2];
  return scope && scope.length > 0 ? scope : null;
}

interface IndexPageArgs {
  formationId: string;
  indexName: string;
  partitionPath: string;
  mode: 'asc' | 'desc';
  cursor: string | null;
  limit: number;
  lookupIndex: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_LOOKUP_INDEX = 'by-id';

function parseIndexPageArgs(args: ToolArgs): IndexPageArgs | string {
  const formationId = stringArg(args, 'formation');
  const indexName = stringArg(args, 'index');
  if (!formationId) return 'formation required';
  if (!indexName) return 'index required';
  const partitionPath = stringArg(args, 'partition');
  const modeRaw = stringArg(args, 'mode').toLowerCase();
  const mode: 'asc' | 'desc' = modeRaw === 'asc' ? 'asc' : 'desc';
  const cursorRaw = stringArg(args, 'cursor');
  const cursor = cursorRaw.length > 0 ? cursorRaw : null;
  const limit = Math.max(1, Math.min(MAX_LIMIT, intArg(args, 'limit', DEFAULT_LIMIT)));
  const lookupIndex = stringArg(args, 'lookupIndex') || DEFAULT_LOOKUP_INDEX;
  return { formationId, indexName, partitionPath, mode, cursor, limit, lookupIndex };
}

/**
 * Build the ListKeysInput shape from parsed args. The RainDB API
 * accepts either the formationId+indexId form (single index lookup)
 * or the raw prefix form (partitioned index lookup -- one prefix per
 * partition). We use the prefix form because the formationId form
 * doesn't carry partitionPath today.
 */
function buildListKeysInput(args: IndexPageArgs): Record<string, unknown> {
  const indexSegment = `indexes/${args.formationId}/${args.indexName}/`;
  const prefix = args.partitionPath
    ? `${indexSegment}${args.partitionPath.replace(/^\/+|\/+$/g, '')}/`
    : indexSegment;
  const input: Record<string, unknown> = { prefix };
  if (args.mode === 'desc') {
    input.last = args.limit + 1;
    if (args.cursor) input.before = args.cursor;
  } else {
    input.first = args.limit + 1;
    if (args.cursor) input.after = args.cursor;
  }
  return input;
}

// ---------------------------------------------------------------------------
// index_page -- the canonical asc/desc + cursor read
// ---------------------------------------------------------------------------

export const index_page: RegisteredTool = {
  name: 'index_page',
  description:
    'Fetch one page of entities from a pointer index in newest-first '
    + '(mode=desc) or oldest-first (mode=asc) order with cursor '
    + 'pagination. Returns the page plus TWO cursors: backCursor '
    + '(oldest in page; use mode=desc + cursor=backCursor for older) '
    + 'and forwardCursor (newest in page; use mode=asc + '
    + 'cursor=forwardCursor to poll for new). Desc reads require the '
    + "formation's index to declare orderByDesc:true. Asc reads work "
    + 'on any pointer index. Use for chat history, recent documents, '
    + 'activity feeds, notifications, audit logs -- any index where '
    + 'the consumption shape is "newest at top, scroll back, poll '
    + 'forward for new". For chain metadata inspection (sealed sets, '
    + 'sentinel state) use chain_status / chain_audit instead.',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: {
        type: 'string',
        description: 'Formation ID (e.g. fdn-chat-messages, gb-message)',
      },
      index: {
        type: 'string',
        description: 'Index name (e.g. by-session, by-conversation, by-update)',
      },
      partition: {
        type: 'string',
        description:
          'Partition path for partitioned indexes (e.g. sessionId for '
          + 'fdn-chat-messages/by-session). Omit for global timelines.',
      },
      mode: {
        type: 'string',
        enum: ['desc', 'asc'],
        description:
          'desc = newest-first (initial load + scroll back); '
          + 'asc = oldest-first (polling for new since cursor). Default desc.',
      },
      cursor: {
        type: 'string',
        description:
          'Pagination cursor. Pass backCursor from a prior desc response '
          + 'to fetch older items; pass forwardCursor with mode=asc to poll '
          + 'for new items.',
      },
      limit: {
        type: 'integer',
        description: `Page size (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
      },
      lookupIndex: {
        type: 'string',
        description:
          'Pointer index used to resolve each scope key to its full '
          + `droplet (default "${DEFAULT_LOOKUP_INDEX}").`,
      },
    },
    required: ['formation', 'index'],
  },
  async execute(ctx, args) {
    const parsed = parseIndexPageArgs(args);
    if (typeof parsed === 'string') return { error: parsed };

    const listInput = buildListKeysInput(parsed);
    const listData = await executeGraphQL<{ listKeys: KeyPage }>(
      LIST_KEYS_QUERY,
      { input: listInput },
      ctx.creds,
      ctx.host,
    );
    const page = listData.listKeys;
    const truncated = !!page.hasMore;
    const rawKeys = page.keys ?? [];

    // Extract scope keys from the pointer-index keys.
    const scopeKeys: string[] = [];
    for (const entry of rawKeys) {
      const sk = scopeKeyFromPointerKey(entry.key);
      if (sk) scopeKeys.push(sk);
    }

    // S3 lex order = UUIDv7 = asc chronological. For desc the chain
    // mirror returns newest-first already; for prefix-mode asc the
    // raw order is asc. When mode=desc we ran the listKeys with
    // last+before so the server already emits newest-first; the
    // emitted scope keys are in newest-first order.
    const pageScopeKeys = scopeKeys.slice(0, parsed.limit);
    const hasMore = scopeKeys.length > parsed.limit || truncated;

    // Resolve each scope key via Tier 2 readLatest in parallel. One
    // unreadable entry is skipped; if EVERY lookup fails, the page is
    // not empty but unresolvable (typically a lookupIndex whose scope
    // value differs from the listed index's last key segment), so the
    // first error is returned instead of an empty page.
    let firstError: string | undefined;
    const fetched = await Promise.all(
      pageScopeKeys.map(async (sk) => {
        try {
          const data = await executeGraphQL<{ readLatest: DropletPayload | null }>(
            READ_LATEST_QUERY,
            {
              input: {
                formationId: parsed.formationId,
                indexId: parsed.lookupIndex,
                scopeValue: sk,
              },
            },
            ctx.creds,
            ctx.host,
          );
          return data.readLatest ? { ...data.readLatest, scopeValue: sk } : null;
        } catch (err) {
          firstError ??= err instanceof Error ? err.message : String(err);
          return null;
        }
      }),
    );
    if (pageScopeKeys.length > 0 && fetched.every((d) => !d) && firstError) {
      return {
        error: `index_page: could not resolve any of ${pageScopeKeys.length} keys via lookupIndex `
          + `"${parsed.lookupIndex}": ${firstError}. Pass a lookupIndex whose scope value is the `
          + `last segment of the "${parsed.indexName}" index keys.`,
      };
    }

    const items: Record<string, unknown>[] = [];
    for (const d of fetched) {
      if (!d || !d.payload) continue;
      const row: Record<string, unknown> = { ...d.payload };
      row.dropletId = d.dropletId;
      row.scopeValue = d.scopeValue;
      row.ts = d.ts;
      items.push(row);
    }

    // Compute the two cursors. For desc mode items[0] is newest; for
    // asc items[length-1] is newest. The cursors are scope keys --
    // pass back as cursor on the next call with the matching mode.
    let forwardCursor: string | null = null;
    let backCursor: string | null = null;
    if (items.length > 0) {
      const newest = parsed.mode === 'desc' ? items[0] : items[items.length - 1];
      const oldest = parsed.mode === 'desc' ? items[items.length - 1] : items[0];
      const newestSv = typeof newest?.scopeValue === 'string' ? newest.scopeValue : null;
      const oldestSv = typeof oldest?.scopeValue === 'string' ? oldest.scopeValue : null;
      forwardCursor = newestSv;
      backCursor = oldestSv;
    }

    const result: IndexPageResult = {
      items,
      hasMore,
      mode: parsed.mode,
      backCursor,
      forwardCursor,
    };
    if (typeof page.totalCount === 'number') {
      result.total = page.totalCount;
    }
    return result;
  },
};

export const indexPageTools: RegisteredTool[] = [index_page];
