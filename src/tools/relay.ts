// relay.ts -- agent tools for relay observability.
//
// Mirrors raindb-phoenix-oc/internal/ai/tools_relay.go::tenantRelayTools.
// 6 tools, all read-only:
//
//   relay_queue   -- list active relays in a queue formation (S3
//                    keys walk via listKeys)
//   relay_status  -- compact status of one relay
//   relay_inspect -- full introspection (status + sub-task IDs +
//                    log IDs + details JSON)
//   relay_logs    -- every log entry for a relay in order
//   relay_tree    -- recursive tree with sub-tasks expanded
//   relay_entity  -- list root relays attached to (formation, entity)
//
// Note: digest_list (in digest.ts) is the PRIMARY tool for
// pipeline-status questions. relay_* tools are for ad-hoc relay
// debugging when the user asks specifically about a relayId.

import { executeGraphQL } from '../client/graphql.js';
import { stringArg } from '../registry/build.js';
import type { RegisteredTool, ToolArgs } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Wire shapes (mirror internal/ops/relay.go)
// ---------------------------------------------------------------------------

export interface RelayAddress {
  formationId: string;
  entityId: string;
  relayId: string;
  parentId?: string;
  primaryId?: string;
}

export interface RelayLogEntry {
  logId: string;
  type: string;
  data: string;
  ts: string;
}

export interface RelayResult {
  relayId: string;
  parentId?: string | null;
  primaryId?: string | null;
  formationId: string;
  entityId: string;
  relayType?: string;
  status: string;
  details?: Record<string, unknown> | null;
  logIds?: string[];
  logs?: RelayLogEntry[];
  subRelays?: RelayResult[];
}

export interface RelayStatusSummary {
  relayId: string;
  formationId: string;
  entityId: string;
  relayType: string;
  status: string;
  parentId?: string;
  primaryId?: string;
  attempt: number;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface RelayInspectView extends RelayStatusSummary {
  subTasks?: string[];
  logIds?: string[];
  details?: Record<string, unknown> | null;
}

export interface RelayQueueEntry {
  relayId: string;
  formationId: string;
  tokenKey: string;
  // Sourced from GraphQL listKeys -> KeyEntry.lastModified, the Time! scalar ->
  // a Unix-MILLISECONDS NUMBER on the wire (NOT the CLI `droplet keys` display
  // string). Reconciled against raindb-prime model KeyEntry.
  lastModified: number;
}

const READ_RELAY_QUERY = `
  query ReadRelay($input: ReadRelayInput!) {
    readRelay(input: $input) {
      relayId
      parentId
      primaryId
      formationId
      entityId
      status
      details
      logIds
      logs {
        logId
        type
        data
        ts
      }
      subRelays {
        relayId
        status
        details
      }
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
      }
      nextCursor
      hasMore
    }
  }
`;

// Common helper: resolve a RelayAddress from tool args.
function relayAddressFromArgs(args: ToolArgs): RelayAddress | string {
  const formation = stringArg(args, 'formation');
  const entityId = stringArg(args, 'entityId');
  const relayId = stringArg(args, 'relayId');
  if (!formation || !entityId || !relayId) {
    return 'formation, entityId, relayId required';
  }
  const addr: RelayAddress = {
    formationId: formation,
    entityId,
    relayId,
  };
  const parentId = stringArg(args, 'parentId');
  const primaryId = stringArg(args, 'primaryId');
  if (parentId) addr.parentId = parentId;
  if (primaryId) addr.primaryId = primaryId;
  return addr;
}

// Common parameter schema for status/inspect/logs/tree.
const RELAY_ADDRESS_PARAMETERS = {
  type: 'object' as const,
  properties: {
    formation: { type: 'string' },
    entityId: { type: 'string' },
    relayId: { type: 'string' },
    parentId: {
      type: 'string',
      description: 'Optional parent relay ID',
    },
    primaryId: {
      type: 'string',
      description: 'Optional primary relay ID',
    },
  },
  required: ['formation', 'entityId', 'relayId'],
};

async function readRelay(
  addr: RelayAddress,
  opts: { logIds?: string[]; tree?: boolean },
  creds: { apiKey?: string; endpoint?: string },
  host: import('../host/types.js').AgentHost | undefined,
): Promise<RelayResult | null> {
  const inner: Record<string, unknown> = {
    address: {
      formationId: addr.formationId,
      entityId: addr.entityId,
      relayId: addr.relayId,
      parentId: addr.parentId ?? '',
      primaryId: addr.primaryId ?? '',
    },
  };
  if (opts.tree) inner['tree'] = true;
  if (opts.logIds && opts.logIds.length > 0) inner['logIds'] = opts.logIds;
  const data = await executeGraphQL<{ readRelay: RelayResult | null }>(
    READ_RELAY_QUERY,
    { input: inner },
    creds,
  );
  return data.readRelay;
}

function summaryFromResult(r: RelayResult): RelayStatusSummary {
  // Mirrors ops/relay.go::summaryFromResult. Status, formation,
  // entity, relayType pulled from the result; details may carry
  // attempt + timestamps.
  const details = r.details ?? {};
  return {
    relayId: r.relayId,
    formationId: r.formationId,
    entityId: r.entityId,
    relayType: r.relayType ?? String(details['relayType'] ?? ''),
    status: r.status,
    parentId: r.parentId ?? undefined,
    primaryId: r.primaryId ?? undefined,
    attempt: typeof details['attempt'] === 'number' ? (details['attempt'] as number) : 0,
    startedAt: typeof details['startedAt'] === 'string' ? (details['startedAt'] as string) : undefined,
    updatedAt: typeof details['updatedAt'] === 'string' ? (details['updatedAt'] as string) : undefined,
    completedAt: typeof details['completedAt'] === 'string' ? (details['completedAt'] as string) : undefined,
    error: typeof details['error'] === 'string' ? (details['error'] as string) : undefined,
  };
}

// ---------------------------------------------------------------------------
// relay_queue -- Go ref: tools_relay.go (lines 16-39)
//   + ops/relay.go::RelayQueueList (lines 525-559)
//
// Walks listKeys against the relay-queue-token prefix:
// `relays/queue/<queueFormation>/<formationFilter>/...` and parses
// each key into (formationId, relayId).
// ---------------------------------------------------------------------------

export const relay_queue: RegisteredTool = {
  name: 'relay_queue',
  description:
    'List active relays in a queue formation. '
    + 'Equivalent CLI: raindb-cli relay queue',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      queueFormation: { type: 'string' },
      formationFilter: {
        type: 'string',
        description: 'Optional filter by origin formation',
      },
    },
    required: ['queueFormation'],
  },
  async execute(ctx, args) {
    const queueFormation = stringArg(args, 'queueFormation');
    if (!queueFormation) {
      return { error: 'queueFormation required' };
    }
    const formationFilter = stringArg(args, 'formationFilter');
    let prefix = `relays/queue/${queueFormation}/`;
    if (formationFilter) {
      prefix += `${formationFilter}/`;
    }
    const allEntries: Array<{ key: string; lastModified: number }> = [];
    let cursor: string | undefined;
    while (true) {
      const input: Record<string, unknown> = { prefix, pageSize: 1000 };
      if (cursor) input['cursor'] = cursor;
      const data = await executeGraphQL<{
        listKeys: {
          keys: Array<{ key: string; size: number; lastModified: number }>;
          nextCursor?: string | null;
          hasMore: boolean;
        };
      }>(LIST_KEYS_QUERY, { input }, ctx.creds, ctx.host);
      for (const k of data.listKeys.keys ?? []) {
        allEntries.push({ key: k.key, lastModified: k.lastModified });
      }
      if (!data.listKeys.hasMore || !data.listKeys.nextCursor) break;
      cursor = data.listKeys.nextCursor;
    }
    // Project keys to entries. Mirrors ops/relay.go:540-557.
    const entries: RelayQueueEntry[] = [];
    for (const { key, lastModified } of allEntries) {
      const parts = key.split('/');
      const last = parts[parts.length - 1] ?? '';
      const relayId = last.endsWith('.json')
        ? last.slice(0, -'.json'.length)
        : last;
      const formationId = parts.length >= 2 ? parts[parts.length - 2]! : '';
      entries.push({
        relayId,
        formationId,
        tokenKey: key,
        lastModified,
      });
    }
    return entries;
  },
};

// ---------------------------------------------------------------------------
// relay_status -- Go ref: tools_relay.go (lines 40-55)
//   + ops/relay.go::RelayStatus (lines 414-420)
// ---------------------------------------------------------------------------

export const relay_status: RegisteredTool = {
  name: 'relay_status',
  description:
    'Compact status for a single relay. '
    + 'Equivalent CLI: raindb-cli relay status',
  minRole: 'read',
  parameters: RELAY_ADDRESS_PARAMETERS,
  async execute(ctx, args) {
    const addrOrErr = relayAddressFromArgs(args);
    if (typeof addrOrErr === 'string') return { error: addrOrErr };
    const result = await readRelay(addrOrErr, {}, ctx.creds, ctx.host);
    if (!result) {
      return { error: `relay not found: ${addrOrErr.relayId}` };
    }
    return summaryFromResult(result);
  },
};

// ---------------------------------------------------------------------------
// relay_inspect -- Go ref: tools_relay.go (lines 56-71)
//   + ops/relay.go::RelayInspect (lines 427-447)
// ---------------------------------------------------------------------------

export const relay_inspect: RegisteredTool = {
  name: 'relay_inspect',
  description:
    'Full relay introspection: status + sub-task IDs + log IDs + details JSON. '
    + 'Equivalent CLI: raindb-cli relay inspect',
  minRole: 'read',
  parameters: RELAY_ADDRESS_PARAMETERS,
  async execute(ctx, args) {
    const addrOrErr = relayAddressFromArgs(args);
    if (typeof addrOrErr === 'string') return { error: addrOrErr };
    const result = await readRelay(addrOrErr, {}, ctx.creds, ctx.host);
    if (!result) {
      return { error: `relay not found: ${addrOrErr.relayId}` };
    }
    const view: RelayInspectView = {
      ...summaryFromResult(result),
      logIds: result.logIds,
      details: result.details,
    };
    // Extract subTasks from details if present (mirrors Go op
    // lines 438-444).
    const details = result.details;
    if (details && Array.isArray((details as Record<string, unknown>)['subTasks'])) {
      view.subTasks = (details as Record<string, unknown>)['subTasks'] as string[];
    }
    return view;
  },
};

// ---------------------------------------------------------------------------
// relay_logs -- Go ref: tools_relay.go (lines 72-87)
//   + ops/relay.go::RelayLogs (lines 459-472)
//
// Two-step: first read to get logIds, then read again with
// logIds passed back to fetch the full log entries.
// ---------------------------------------------------------------------------

export const relay_logs: RegisteredTool = {
  name: 'relay_logs',
  description:
    'Read every log entry for a relay in order. '
    + 'Equivalent CLI: raindb-cli relay logs',
  minRole: 'read',
  parameters: RELAY_ADDRESS_PARAMETERS,
  async execute(ctx, args) {
    const addrOrErr = relayAddressFromArgs(args);
    if (typeof addrOrErr === 'string') return { error: addrOrErr };
    const ids = await readRelay(addrOrErr, {}, ctx.creds, ctx.host);
    if (!ids) {
      return { error: `relay not found: ${addrOrErr.relayId}` };
    }
    if (!ids.logIds || ids.logIds.length === 0) {
      return [] as RelayLogEntry[];
    }
    const full = await readRelay(addrOrErr, { logIds: ids.logIds }, ctx.creds, ctx.host);
    return full?.logs ?? [];
  },
};

// ---------------------------------------------------------------------------
// relay_tree -- Go ref: tools_relay.go (lines 88-103)
//   + ops/relay.go::RelayTree (lines 478-480)
// ---------------------------------------------------------------------------

export const relay_tree: RegisteredTool = {
  name: 'relay_tree',
  description:
    'Show recursive relay tree with sub-tasks expanded. '
    + 'Equivalent CLI: raindb-cli relay tree',
  minRole: 'read',
  parameters: RELAY_ADDRESS_PARAMETERS,
  async execute(ctx, args) {
    const addrOrErr = relayAddressFromArgs(args);
    if (typeof addrOrErr === 'string') return { error: addrOrErr };
    const result = await readRelay(addrOrErr, { tree: true }, ctx.creds, ctx.host);
    if (!result) {
      return { error: `relay not found: ${addrOrErr.relayId}` };
    }
    return result;
  },
};

// ---------------------------------------------------------------------------
// relay_entity -- Go ref: tools_relay.go (lines 104-126)
//   + ops/relay.go::RelayListForEntity (lines 487-514)
//
// Walks listKeys against the relay base prefix
// `relays/<formation>/<entityId>/` and projects each unique
// relayId.
// ---------------------------------------------------------------------------

export const relay_entity: RegisteredTool = {
  name: 'relay_entity',
  description:
    'List every root relay belonging to an entity (by formation + entityId). '
    + 'Equivalent CLI: raindb-cli relay entity',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      entityId: { type: 'string' },
    },
    required: ['formation', 'entityId'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const entityId = stringArg(args, 'entityId');
    if (!formation || !entityId) {
      return { error: 'formation and entityId required' };
    }
    const prefix = `relays/${formation}/${entityId}/`;
    const seen = new Set<string>();
    const ids: string[] = [];
    let cursor: string | undefined;
    while (true) {
      const input: Record<string, unknown> = { prefix, pageSize: 1000 };
      if (cursor) input['cursor'] = cursor;
      const data = await executeGraphQL<{
        listKeys: {
          keys: Array<{ key: string }>;
          nextCursor?: string | null;
          hasMore: boolean;
        };
      }>(LIST_KEYS_QUERY, { input }, ctx.creds, ctx.host);
      for (const k of data.listKeys.keys ?? []) {
        // Path layout (verified via paths.RelayBaseRelPath +
        // surrounding code): relays/<formation>/<entityId>/<relayId>/...
        // The relayId is the segment immediately after entityId.
        const trimmed = k.key.startsWith(prefix)
          ? k.key.slice(prefix.length)
          : k.key;
        const idx = trimmed.indexOf('/');
        const id = idx > 0 ? trimmed.slice(0, idx) : trimmed;
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      if (!data.listKeys.hasMore || !data.listKeys.nextCursor) break;
      cursor = data.listKeys.nextCursor;
    }
    return ids;
  },
};

export const relayTools: RegisteredTool[] = [
  relay_queue,
  relay_status,
  relay_inspect,
  relay_logs,
  relay_tree,
  relay_entity,
];
