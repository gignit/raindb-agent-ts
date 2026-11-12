// droplet.ts -- agent tools for droplet primitives.
//
// 9 tools landed (M1 + M2 batch 2):
//   read-side (5):  droplet_read_current, droplet_read_by_id,
//                   droplet_read_latest, droplet_list, droplet_keys
//   mutating (4):   droplet_create, droplet_update,
//                   droplet_push_public,
//                   droplet_bulk_create, droplet_bulk_update
//
// Deferred (filesystem-bound; M2 checklist J.5 + B.9 + B.10):
//   droplet_upload   -- reads from API host filesystem
//   droplet_download -- writes to API host filesystem

import { executeGraphQL } from '../client/graphql.js';
import {
  boolArg,
  intArg,
  objectArg,
  stringArg,
} from '../registry/build.js';
import type { RegisteredTool, ToolArgs } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Wire shapes.
// ---------------------------------------------------------------------------

export interface DropletResult {
  dropletId: string;
  formationId: string;
  schemaVersion: number;
  /**
   * Write timestamp in Unix MILLISECONDS as a NUMBER. The GraphQL Time
   * scalar marshals as a bare JSON number, not a string. Was mistyped
   * `string`, which broke date math on every consumer; corrected to match
   * the wire + @raindb/bolt-sdk Droplet.ts.
   */
  ts: number;
  author: string;
  tenantId?: string;
  batchId?: string;
  payload: Record<string, unknown> | null;
  /**
   * Per-float metadata records, one entry per floated binary field -- an
   * ARRAY (GraphQL Droplet.floatMeta is [JSON!], Go []JSON). Present only
   * when the droplet has floated fields (omitempty; omitted, never null).
   * Was mistyped as a single nullable object; corrected to match the wire
   * + @raindb/bolt-sdk Droplet.floatMeta.
   */
  floatMeta?: Record<string, unknown>[];
  pointerETag?: string | null;
}

export interface DropletPage {
  droplets: DropletResult[];
  nextCursor?: string | null;
  hasMore: boolean;
}

export interface KeyEntry {
  key: string;
  size: number;
  // GraphQL KeyEntry.lastModified is the Time! scalar -> Unix-MILLISECONDS
  // NUMBER over the wire. (NB: this differs from the bolt sandbox host binding
  // used by @raindb/bolt-sdk, which emits an RFC3339 string for engine parity
  // -- that is the HOST boundary, not the GraphQL wire this raw client decodes.)
  lastModified: number;
  etag?: string;
}

export interface KeyPage {
  keys: KeyEntry[];
  nextCursor?: string | null;
  hasMore: boolean;
  totalCount: number;
}

export interface WriteResult {
  dropletId: string;
  pathsWritten: string[];
  floatPaths: string[];
  publicUrls: string[];
  vectorRefs: string[];
  warnings: string[];
  scopeValue?: string | null;
  pointerETag?: string | null;
  durationMs: number;
}

export interface PushPublicResult {
  publicUrl: string;
  publicPath: string;
  contentType: string;
  size: number;
}

export interface BulkDropletResult {
  index: number;
  dropletId?: string;
  scopeValue?: string;
  succeeded: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// GraphQL operations.
// ---------------------------------------------------------------------------

const READ_CURRENT_QUERY = `
  query ReadCurrent($input: ReadCurrentInput!) {
    readCurrent(input: $input) {
      dropletId
      formationId
      schemaVersion
      ts
      author
      tenantId
      batchId
      payload
      floatMeta
      pointerETag
    }
  }
`;

const READ_DROPLET_QUERY = `
  query ReadDroplet($input: ReadDropletInput!) {
    readDroplet(input: $input) {
      dropletId
      formationId
      schemaVersion
      ts
      author
      tenantId
      batchId
      payload
      floatMeta
    }
  }
`;

const READ_LATEST_QUERY = `
  query ReadLatest($input: ReadLatestInput!) {
    readLatest(input: $input) {
      dropletId
      formationId
      schemaVersion
      ts
      author
      tenantId
      batchId
      payload
      floatMeta
      pointerETag
    }
  }
`;

const LIST_DROPLETS_QUERY = `
  query ListDroplets($input: ListDropletsInput!) {
    listDroplets(input: $input) {
      droplets {
        dropletId
        formationId
        schemaVersion
        ts
        author
        payload
      }
      nextCursor
      hasMore
    }
  }
`;

const LIST_KEYS_QUERY = `
  query ListKeys($input: ListKeysInput!) {
    listKeys(input: $input) {
      keys {
        key
        size
        lastModified
        etag
      }
      nextCursor
      hasMore
      totalCount
    }
  }
`;

const WRITE_DROPLET_MUTATION = `
  mutation WriteDroplet($input: WriteDropletInput!) {
    writeDroplet(input: $input) {
      dropletId
      pathsWritten
      floatPaths
      publicUrls
      vectorRefs
      warnings
      scopeValue
      pointerETag
      durationMs
    }
  }
`;

const PUSH_PUBLIC_MUTATION = `
  mutation PushPublic($input: PushPublicInput!) {
    pushPublic(input: $input) {
      publicUrl
      publicPath
      contentType
      size
    }
  }
`;

// Helper: resolve writer identity. Prefers ctx.userId (host-supplied);
// falls back to "agent" so audit logs identify writes as agent-surface.
function resolveAuthor(userId?: string): string {
  return userId && userId.trim() !== '' ? userId : 'agent';
}

/**
 * Coerce the `scope` arg of droplet_read_current. The Go side (Schema:
 * "string") accepts a JSON string OR a plain string; ReadCurrentInput
 * on the resolver side calls parseScope which accepts either a flat
 * string (mapped to scopeKey) or a JSON object. We normalize here:
 * if the model emits an object, pass it through; if a JSON-encoded
 * object, parse it; otherwise pass the string verbatim.
 */
function coerceScope(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // fall through and pass as plain string
      }
    }
    return trimmed;
  }
  return String(raw);
}

// ---------------------------------------------------------------------------
// droplet_read_current
// ---------------------------------------------------------------------------

export const droplet_read_current: RegisteredTool = {
  name: 'droplet_read_current',
  description:
    'Read the current droplet for (formation, scope). Returns the most recent '
    + 'pointer target. Equivalent CLI: raindb-cli droplet read',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string', description: 'Formation ID' },
      scope: {
        type: 'string',
        description: 'Scope value (JSON or plain string)',
      },
    },
    required: ['formation', 'scope'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const scope = coerceScope(args['scope']);
    if (!formation || scope === null || scope === '') {
      return { error: 'formation and scope are required' };
    }
    const data = await executeGraphQL<{ readCurrent: DropletResult | null }>(
      READ_CURRENT_QUERY,
      { input: { formationId: formation, scope } },
      ctx.creds,
      ctx.host,
    );
    if (!data.readCurrent) {
      return { error: `droplet not found: ${formation}/${String(scope)}` };
    }
    return data.readCurrent;
  },
};

// ---------------------------------------------------------------------------
// droplet_read_by_id
// ---------------------------------------------------------------------------

export const droplet_read_by_id: RegisteredTool = {
  name: 'droplet_read_by_id',
  description:
    'Read a specific droplet by its UUID. Equivalent CLI: raindb-cli droplet read-id',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      id: { type: 'string', description: 'Droplet UUID' },
    },
    required: ['formation', 'id'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const id = stringArg(args, 'id');
    if (!formation || !id) {
      return { error: 'formation and id are required' };
    }
    const data = await executeGraphQL<{ readDroplet: DropletResult | null }>(
      READ_DROPLET_QUERY,
      { input: { formationId: formation, dropletId: id } },
      ctx.creds,
      ctx.host,
    );
    if (!data.readDroplet) {
      return { error: `droplet not found: ${id}` };
    }
    return data.readDroplet;
  },
};

// ---------------------------------------------------------------------------
// droplet_read_latest
// ---------------------------------------------------------------------------

export const droplet_read_latest: RegisteredTool = {
  name: 'droplet_read_latest',
  description:
    'Read the droplet indexed at (formation, index, value). Useful for '
    + 'by-id / by-email style index lookups. Equivalent CLI: '
    + 'raindb-cli droplet read-latest',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      index: { type: 'string', description: 'Index name (e.g., by-id)' },
      value: { type: 'string' },
    },
    required: ['formation', 'index', 'value'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const index = stringArg(args, 'index');
    const value = stringArg(args, 'value');
    if (!formation || !index || !value) {
      return { error: 'formation, index, value all required' };
    }
    const data = await executeGraphQL<{ readLatest: DropletResult | null }>(
      READ_LATEST_QUERY,
      {
        input: { formationId: formation, indexId: index, scopeValue: value },
      },
      ctx.creds,
      ctx.host,
    );
    if (!data.readLatest) {
      return { error: `droplet not found: ${formation}/${index}/${value}` };
    }
    return data.readLatest;
  },
};

// ---------------------------------------------------------------------------
// droplet_list
// ---------------------------------------------------------------------------

export const droplet_list: RegisteredTool = {
  name: 'droplet_list',
  description:
    'List droplet keys under a formation prefix (structured droplet rows). '
    + "Pass optional 'scopeValue' to resolve a semantic entity scope "
    + 'server-side before the LIST. '
    + 'Equivalent CLI: raindb-cli droplet list',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      scopeValue: {
        type: 'string',
        description:
          "Optional semantic entity scope; resolved to the entity's "
          + 'prefix server-side before listing.',
      },
      prefix: { type: 'string', description: 'Optional prefix filter' },
      pageSize: { type: 'integer', description: 'Max results (default 100)' },
    },
    required: ['formation'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    if (!formation) {
      return { error: 'formation required' };
    }
    const input: Record<string, unknown> = {
      formationId: formation,
      pageSize: intArg(args, 'pageSize', 100),
    };
    const prefix = stringArg(args, 'prefix');
    if (prefix) input['prefix'] = prefix;
    const scopeValue = stringArg(args, 'scopeValue');
    if (scopeValue) input['scopeValue'] = scopeValue;
    const data = await executeGraphQL<{ listDroplets: DropletPage }>(
      LIST_DROPLETS_QUERY,
      { input },
      ctx.creds,
      ctx.host,
    );
    return data.listDroplets;
  },
};

// ---------------------------------------------------------------------------
// droplet_keys
// ---------------------------------------------------------------------------

export const droplet_keys: RegisteredTool = {
  name: 'droplet_keys',
  description:
    'List raw S3 keys under a tenant-relative prefix (debugging / auditing '
    + 'S3 layout directly). Differs from droplet.list which returns structured '
    + 'droplet rows. Equivalent CLI: raindb-cli droplet keys',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      prefix: {
        type: 'string',
        description: 'S3 prefix under the tenant root',
      },
    },
    required: ['prefix'],
  },
  async execute(ctx, args) {
    const prefix = stringArg(args, 'prefix');
    if (!prefix) {
      return { error: 'prefix required' };
    }
    // Iterate pages until exhausted -- mirrors the Go op's
    // ListAllKeys (which walks all pages internally). The Go side
    // uses pageSize=0 to mean "unbounded"; the GraphQL surface
    // accepts a limit, so we paginate explicitly.
    const allKeys: KeyEntry[] = [];
    let cursor: string | undefined;
    while (true) {
      const input: Record<string, unknown> = {
        prefix,
        pageSize: 1000,
      };
      if (cursor) input['cursor'] = cursor;
      const data = await executeGraphQL<{ listKeys: KeyPage }>(
        LIST_KEYS_QUERY,
        { input },
        ctx.creds,
      ctx.host,
      );
      const page = data.listKeys;
      allKeys.push(...(page.keys ?? []));
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return { keys: allKeys.map((k) => k.key) };
  },
};

// ---------------------------------------------------------------------------
// droplet_create
// ---------------------------------------------------------------------------

export const droplet_create: RegisteredTool = {
  name: 'droplet_create',
  description:
    'Create a new droplet in a formation. Optionally dispatches flow events. '
    + 'Equivalent CLI: raindb-cli droplet create --formation <id> --payload <json>.',
  minRole: 'write',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      payload: {
        type: 'object',
        description: "Droplet payload; shape follows the formation's schema.",
      },
      triggerFlows: {
        type: 'boolean',
        description: 'Dispatch flow events (default true).',
      },
    },
    required: ['formation', 'payload'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const payload = objectArg(args, 'payload');
    if (!formation) {
      return { error: 'formation is required' };
    }
    if (!payload) {
      return { error: 'payload (object) is required' };
    }
    const triggerFlows = boolArg(args, 'triggerFlows', true);
    const data = await executeGraphQL<{ writeDroplet: WriteResult }>(
      WRITE_DROPLET_MUTATION,
      {
        input: {
          formationId: formation,
          payload,
          author: resolveAuthor(ctx.userId),
          triggerFlows,
        },
      },
      ctx.creds,
      ctx.host,
    );
    return data.writeDroplet;
  },
};

// ---------------------------------------------------------------------------
// droplet_update
//
// Read-modify-write with CAS retry. Collapses the retry loop into a
// single API call: the GraphQL writeDroplet mutation already supports
// expectedETag for CAS, and we read the current droplet via readLatest
// first to get the etag. On concurrent-update we DO NOT auto-retry here
// because the agent loop is iterative -- the model can re-issue the
// tool call if it sees a CAS failure. Keeps this tool body simple.
// ---------------------------------------------------------------------------

export const droplet_update: RegisteredTool = {
  name: 'droplet_update',
  description:
    "Read-modify-write a droplet with CAS retry. Pass a 'changes' object; "
    + 'the fields are merged into the current payload under by-id. '
    + 'Equivalent CLI: raindb-cli droplet update',
  minRole: 'write',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      scope: {
        type: 'string',
        description: 'Scope value identifying the entity (by-id)',
      },
      changes: {
        type: 'object',
        description: 'Fields to merge into the existing payload',
      },
      triggerFlows: {
        type: 'boolean',
        description: 'Dispatch flow events (default true)',
      },
    },
    required: ['formation', 'scope', 'changes'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const scope = stringArg(args, 'scope');
    const changes = objectArg(args, 'changes');
    if (!formation || !scope || !changes) {
      return { error: 'formation, scope, changes (object) required' };
    }
    const triggerFlows = boolArg(args, 'triggerFlows', true);

    // Step 1: read current droplet via by-id to grab the
    // pointerETag for CAS.
    const readResp = await executeGraphQL<{ readLatest: DropletResult | null }>(
      READ_LATEST_QUERY,
      {
        input: {
          formationId: formation,
          indexId: 'by-id',
          scopeValue: scope,
        },
      },
      ctx.creds,
      ctx.host,
    );
    if (!readResp.readLatest) {
      return { error: `droplet not found: ${formation}/${scope}` };
    }
    const current = readResp.readLatest;
    const merged: Record<string, unknown> = {
      ...(current.payload ?? {}),
      ...changes,
    };

    // Step 2: write back with expectedETag.
    const writeResp = await executeGraphQL<{ writeDroplet: WriteResult }>(
      WRITE_DROPLET_MUTATION,
      {
        input: {
          formationId: formation,
          payload: merged,
          author: resolveAuthor(ctx.userId),
          triggerFlows,
          expectedETag: current.pointerETag ?? '',
        },
      },
      ctx.creds,
      ctx.host,
    );
    return writeResp.writeDroplet;
  },
};

// ---------------------------------------------------------------------------
// droplet_push_public
// ---------------------------------------------------------------------------

export const droplet_push_public: RegisteredTool = {
  name: 'droplet_push_public',
  description:
    "Mirror a private droplet's float fields to the public bucket. Returns "
    + 'the public URLs. Equivalent CLI: raindb-cli droplet push-public',
  minRole: 'write',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      dropletId: { type: 'string' },
    },
    required: ['formation', 'dropletId'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const dropletId = stringArg(args, 'dropletId');
    if (!formation || !dropletId) {
      return { error: 'formation and dropletId required' };
    }
    const data = await executeGraphQL<{ pushPublic: PushPublicResult }>(
      PUSH_PUBLIC_MUTATION,
      { input: { formationId: formation, dropletId } },
      ctx.creds,
      ctx.host,
    );
    return data.pushPublic;
  },
};

// ---------------------------------------------------------------------------
// droplet_bulk_create
//
// Skip the `filePath` arm (filesystem-only; host applications have no
// operator filesystem). Accept only `entries`. Per-entry success/failure
// reported; one entry's failure does not abort the others.
// ---------------------------------------------------------------------------

export const droplet_bulk_create: RegisteredTool = {
  name: 'droplet_bulk_create',
  description:
    'Create multiple droplets in one call. Pass an array of payload objects. '
    + 'Per-entry success/failure reported independently. '
    + 'Equivalent CLI: raindb-cli droplet create --formation <id> --file <path>',
  minRole: 'write',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      entries: {
        type: 'array',
        description: 'Array of droplet payload objects',
        items: { type: 'object' },
      },
      triggerFlows: {
        type: 'boolean',
        description: 'Dispatch flow events (default false for bulk provisioning)',
      },
    },
    required: ['formation', 'entries'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const rawEntries = args['entries'];
    if (!formation) {
      return { error: 'formation required' };
    }
    if (!Array.isArray(rawEntries)) {
      return { error: 'entries (array) required' };
    }
    const triggerFlows = boolArg(args, 'triggerFlows', false);
    const author = resolveAuthor(ctx.userId);
    const results: BulkDropletResult[] = [];
    for (let i = 0; i < rawEntries.length; i += 1) {
      const entry = rawEntries[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        results.push({
          index: i,
          succeeded: false,
          error: `entries[${i}] is not an object`,
        });
        continue;
      }
      try {
        const data = await executeGraphQL<{ writeDroplet: WriteResult }>(
          WRITE_DROPLET_MUTATION,
          {
            input: {
              formationId: formation,
              payload: entry as Record<string, unknown>,
              author,
              triggerFlows,
            },
          },
          ctx.creds,
      ctx.host,
        );
        results.push({
          index: i,
          dropletId: data.writeDroplet.dropletId,
          succeeded: true,
        });
      } catch (err) {
        results.push({
          index: i,
          succeeded: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  },
};

// ---------------------------------------------------------------------------
// droplet_bulk_update
//
// Same simplification as bulk_create (no filePath). Each entry must
// carry the scopeKey field; the rest merges onto the existing payload.
// ---------------------------------------------------------------------------

export const droplet_bulk_update: RegisteredTool = {
  name: 'droplet_bulk_update',
  description:
    'Update multiple droplets in one call. Each entry must carry the scopeKey '
    + 'field (locating the existing droplet); other fields merge onto the '
    + 'payload with CAS retry. Equivalent CLI: raindb-cli droplet update '
    + '--formation <id> --file <path> --scope-key <key>',
  minRole: 'write',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      scopeKey: {
        type: 'string',
        description:
          "Payload field whose value locates the existing droplet (e.g., 'modelId' for platform-llm-model)",
      },
      entries: {
        type: 'array',
        description:
          'Array of partial payload objects (must contain scopeKey)',
        items: { type: 'object' },
      },
      index: {
        type: 'string',
        description: 'Formation index for the RMW lookup (default by-id)',
      },
      triggerFlows: {
        type: 'boolean',
        description: 'Dispatch flow events (default false for bulk updates)',
      },
    },
    required: ['formation', 'scopeKey', 'entries'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const scopeKey = stringArg(args, 'scopeKey');
    const rawEntries = args['entries'];
    if (!formation || !scopeKey) {
      return { error: 'formation and scopeKey required' };
    }
    if (!Array.isArray(rawEntries)) {
      return { error: 'entries (array) required' };
    }
    const index = stringArg(args, 'index') || 'by-id';
    const triggerFlows = boolArg(args, 'triggerFlows', false);
    const updateArgs: ToolArgs = { formation, triggerFlows };
    const results: BulkDropletResult[] = [];

    for (let i = 0; i < rawEntries.length; i += 1) {
      const entry = rawEntries[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        results.push({
          index: i,
          succeeded: false,
          error: `entries[${i}] is not an object`,
        });
        continue;
      }
      const entryRecord = entry as Record<string, unknown>;
      const scopeVal = entryRecord[scopeKey];
      if (typeof scopeVal !== 'string' || scopeVal === '') {
        results.push({
          index: i,
          succeeded: false,
          error: `entry missing scope key "${scopeKey}" (type=${typeof scopeVal})`,
        });
        continue;
      }
      try {
        // Per-entry RMW. Reuse droplet_update.execute since the
        // wire shape is identical.
        const r = await droplet_update.execute(ctx, {
          ...updateArgs,
          scope: scopeVal,
          changes: entryRecord,
          index,
        });
        if (r && typeof r === 'object' && 'error' in (r as Record<string, unknown>)) {
          results.push({
            index: i,
            scopeValue: scopeVal,
            succeeded: false,
            error: String((r as Record<string, unknown>)['error']),
          });
        } else {
          const wr = r as WriteResult;
          results.push({
            index: i,
            scopeValue: scopeVal,
            dropletId: wr.dropletId,
            succeeded: true,
          });
        }
      } catch (err) {
        results.push({
          index: i,
          scopeValue: scopeVal,
          succeeded: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  },
};

/**
 * Per-domain catalog. Order is stable so the model sees a
 * consistent surface across raindb-cli + Node consumers.
 */
export const dropletTools: RegisteredTool[] = [
  droplet_read_current,
  droplet_read_by_id,
  droplet_read_latest,
  droplet_list,
  droplet_keys,
  droplet_create,
  droplet_update,
  droplet_push_public,
  // droplet_upload   -- deferred (filesystem)
  // droplet_download -- deferred (filesystem)
  droplet_bulk_create,
  droplet_bulk_update,
];
