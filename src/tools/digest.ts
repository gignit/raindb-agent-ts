// digest.ts -- agent tools for digest-pipeline status.
//
// 2 tools, both read-only:
//
//   digest_list  -- per-entity status with stage breakdown
//   digest_show  -- one entity's full digest detail
//
// Status synthesis walks:
//   1. ListDroplets to get entity IDs (via formation scopeKey)
//   2. list root relays per id
//   3. read the relay tree on the latest root to get the full sub-relay tree
//   4. Stage-walker projection from sub-relay status to ActionStage
//
// Relay reads are delegated to the GraphQL surface used by
// relay_tree / relay_entity.

import { executeGraphQL } from '../client/graphql.js';
import { stringArg } from '../registry/build.js';
import type { RegisteredTool } from '../registry/types.js';
import type { RelayResult } from './relay.js';

// ---------------------------------------------------------------------------
// Wire shapes.
// ---------------------------------------------------------------------------

export interface ActionStage {
  name: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  detail?: string;
  error?: string;
}

export interface DigestEntityStatus {
  formationId: string;
  entityId: string;
  filename?: string;
  status: string;
  durationMs?: number;
  stages?: ActionStage[];
  rootRelayId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// GraphQL operations (we hit listDroplets + readRelay through the
// same surface the relay tools use, plus describeFormation to learn
// the scopeKey).
// ---------------------------------------------------------------------------

const DESCRIBE_FORMATION_QUERY = `
  query DescribeFormation($formationId: String!) {
    describeFormation(formationId: $formationId) {
      scopeKey
    }
  }
`;

const LIST_DROPLETS_QUERY = `
  query ListDroplets($input: ListDropletsInput!) {
    listDroplets(input: $input) {
      droplets {
        dropletId
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
      }
      nextCursor
      hasMore
    }
  }
`;

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

// ---------------------------------------------------------------------------
// Helpers (mirror Go internals)
// ---------------------------------------------------------------------------

async function resolveScopeKey(
  formation: string,
  creds: { apiKey?: string; endpoint?: string },
  host: import('../host/types.js').AgentHost | undefined,
): Promise<string> {
  // Best-effort describe; fall back to "id" on any failure.
  try {
    const data = await executeGraphQL<{
      describeFormation: { scopeKey?: string } | null;
    }>(DESCRIBE_FORMATION_QUERY, { formationId: formation }, creds, host);
    const sk = data.describeFormation?.scopeKey;
    if (sk && sk !== '') return sk;
  } catch {
    // fall through
  }
  return 'id';
}

function extractEntityID(
  payload: Record<string, unknown> | null | undefined,
  scopeKey: string,
): string {
  if (!payload || !scopeKey) return '';
  const v = payload[scopeKey];
  return typeof v === 'string' ? v : '';
}

async function listEntityIds(
  formation: string,
  creds: { apiKey?: string; endpoint?: string },
  host: import('../host/types.js').AgentHost | undefined,
): Promise<string[]> {
  // ListDroplets through 200-page-size, project each payload to its
  // scopeKey, dedupe.
  const scopeKey = await resolveScopeKey(formation, creds, host);
  const data = await executeGraphQL<{
    listDroplets: {
      droplets: Array<{ dropletId: string; payload: Record<string, unknown> | null }>;
      hasMore: boolean;
    };
  }>(
    LIST_DROPLETS_QUERY,
    { input: { formationId: formation, pageSize: 200 } },
    creds,
  );
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const d of data.listDroplets.droplets ?? []) {
    const id = extractEntityID(d.payload, scopeKey);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

async function listRootRelayIds(
  formation: string,
  entityId: string,
  creds: { apiKey?: string; endpoint?: string },
  host: import('../host/types.js').AgentHost | undefined,
): Promise<string[]> {
  // List keys under relays/<formation>/<entityId>/, project unique
  // relayIds (the segment after entityId).
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
    }>(LIST_KEYS_QUERY, { input }, creds, host);
    for (const k of data.listKeys.keys ?? []) {
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
}

async function readRelayTree(
  formation: string,
  entityId: string,
  relayId: string,
  creds: { apiKey?: string; endpoint?: string },
  host: import('../host/types.js').AgentHost | undefined,
): Promise<RelayResult | null> {
  const data = await executeGraphQL<{ readRelay: RelayResult | null }>(
    READ_RELAY_QUERY,
    {
      input: {
        address: {
          formationId: formation,
          entityId,
          relayId,
          parentId: '',
          primaryId: '',
        },
        tree: true,
      },
    },
    creds,
  );
  return data.readRelay;
}

interface ActionContext {
  actionFormation: string;
  filename: string;
  rootStartedAt: string;
}

function readActionContext(tree: RelayResult | null): ActionContext {
  if (!tree || !tree.details) {
    return { actionFormation: '', filename: '', rootStartedAt: '' };
  }
  const details = tree.details;
  const relayType = typeof details['relayType'] === 'string' ? (details['relayType'] as string) : '';
  const startedAt = typeof details['startedAt'] === 'string' ? (details['startedAt'] as string) : '';
  const input = details['input'] as Record<string, unknown> | undefined;
  let actionFormation = '';
  let filename = '';
  if (input) {
    if (typeof input['actionFormation'] === 'string') {
      actionFormation = input['actionFormation'] as string;
    } else if (typeof input['actionId'] === 'string') {
      actionFormation = input['actionId'] as string;
    }
    const payload = input['payload'] as Record<string, unknown> | undefined;
    if (payload) {
      if (typeof payload['filename'] === 'string') {
        filename = payload['filename'] as string;
      } else if (typeof payload['fileDataFilename'] === 'string') {
        filename = payload['fileDataFilename'] as string;
      }
    }
  }
  if (actionFormation === '' && relayType !== '') {
    const idx = relayType.indexOf('-');
    if (idx > 0) actionFormation = relayType.slice(0, idx);
  }
  return { actionFormation, filename, rootStartedAt: startedAt };
}

/**
 * Generic stage walker. Projects each immediate sub-relay as one
 * stage with the relay's status + details. Action-type specifics can
 * land later if needed for host tooling.
 */
function walkStages(tree: RelayResult): ActionStage[] {
  if (!tree.subRelays) return [];
  const stages: ActionStage[] = [];
  for (const sub of tree.subRelays) {
    const details = sub.details ?? {};
    const relayType = typeof details['relayType'] === 'string'
      ? (details['relayType'] as string)
      : (sub.relayType ?? '');
    const stage: ActionStage = {
      name: relayType || sub.relayId,
      status: sub.status,
    };
    const startedAt = typeof details['startedAt'] === 'string'
      ? (details['startedAt'] as string)
      : '';
    const completedAt = typeof details['completedAt'] === 'string'
      ? (details['completedAt'] as string)
      : '';
    if (startedAt) stage.startedAt = startedAt;
    if (completedAt) stage.completedAt = completedAt;
    if (startedAt && completedAt) {
      const a = Date.parse(startedAt);
      const b = Date.parse(completedAt);
      if (!Number.isNaN(a) && !Number.isNaN(b) && b >= a) {
        stage.durationMs = b - a;
      }
    }
    if (typeof details['error'] === 'string' && (details['error'] as string) !== '') {
      stage.error = details['error'] as string;
    }
    if (typeof details['detail'] === 'string' && (details['detail'] as string) !== '') {
      stage.detail = details['detail'] as string;
    }
    stages.push(stage);
  }
  return stages;
}

function computeOverall(rootStatus: string, stages: ActionStage[]): string {
  // If any stage failed -> failed; if root is running and any
  // stage is running -> running; if all stages complete + root
  // complete -> complete. Default to root status.
  for (const s of stages) {
    if (s.status === 'failed' || s.status === 'error') return s.status;
  }
  return rootStatus;
}

function computeDuration(rootStartedAt: string, stages: ActionStage[]): number {
  // From root start to latest completedAt across stages.
  if (rootStartedAt === '') return 0;
  const start = Date.parse(rootStartedAt);
  if (Number.isNaN(start)) return 0;
  let latest = 0;
  for (const s of stages) {
    if (s.completedAt) {
      const t = Date.parse(s.completedAt);
      if (!Number.isNaN(t) && t > latest) latest = t;
    }
  }
  if (latest === 0) return 0;
  return Math.max(0, latest - start);
}

async function synthesizeStatus(
  formation: string,
  entityId: string,
  creds: { apiKey?: string; endpoint?: string },
  host: import('../host/types.js').AgentHost | undefined,
): Promise<DigestEntityStatus> {
  const rootIds = await listRootRelayIds(formation, entityId, creds, host);
  if (rootIds.length === 0) {
    return {
      formationId: formation,
      entityId,
      status: 'no-action-found',
    };
  }
  const rootId = rootIds[rootIds.length - 1]!;
  const tree = await readRelayTree(formation, entityId, rootId, creds, host);
  if (!tree) {
    return {
      formationId: formation,
      entityId,
      status: 'error',
      error: `relay tree not found for root ${rootId}`,
    };
  }
  const ctxInfo = readActionContext(tree);
  const stages = walkStages(tree);
  const overall = computeOverall(tree.status, stages);
  const durationMs = computeDuration(ctxInfo.rootStartedAt, stages);
  const out: DigestEntityStatus = {
    formationId: formation,
    entityId,
    status: overall,
    rootRelayId: rootId,
  };
  if (ctxInfo.filename) out.filename = ctxInfo.filename;
  if (durationMs > 0) out.durationMs = durationMs;
  if (stages.length > 0) out.stages = stages;
  return out;
}

// ---------------------------------------------------------------------------
// digest_list
// ---------------------------------------------------------------------------

export const digest_list: RegisteredTool = {
  name: 'digest_list',
  description:
    'PRIMARY tool for any question about file/document/digest status, '
    + 'ingestion pipeline, processing progress, or relay trees in a '
    + 'formation. Returns one row per entity (file/document) with '
    + 'filename + overall verdict (complete/running/queued/failed) + '
    + 'per-stage breakdown (extract/chunk/embed pages, chunks, tokens, '
    + 'cost) + total duration + root relayId. Use this INSTEAD OF '
    + "relay_queue, relay_tree, relay_entity for any question about 'all "
    + "my files', 'all my documents', 'digest status', 'pipeline status', "
    + "'what's still processing', 'show me the relay tree for the "
    + "formation'. Equivalent CLI: raindb-cli digest list <formation>. "
    + 'Typical formation: fdn_documents.',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: {
        type: 'string',
        description:
          'Formation ID -- typically fdn_documents for user-uploaded files.',
      },
    },
    required: ['formation'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    if (!formation) return { error: 'formation required' };
    const ids = await listEntityIds(formation, ctx.creds, ctx.host);
    if (ids.length === 0) return [] as DigestEntityStatus[];
    // Synthesize per id. Concurrency cap defaults to 8 to keep
    // S3 + the RainDB API parallelism reasonable.
    const concurrency = 8;
    const results: DigestEntityStatus[] = new Array(ids.length);
    let next = 0;
    async function worker(): Promise<void> {
      while (true) {
        const i = next;
        next += 1;
        if (i >= ids.length) return;
        try {
          results[i] = await synthesizeStatus(formation, ids[i]!, ctx.creds, ctx.host);
        } catch (err) {
          results[i] = {
            formationId: formation,
            entityId: ids[i]!,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }
    const workers: Array<Promise<void>> = [];
    for (let w = 0; w < concurrency; w += 1) workers.push(worker());
    await Promise.all(workers);
    // Sort by filename then entityId.
    results.sort((a, b) => {
      const fa = a.filename ?? '';
      const fb = b.filename ?? '';
      if (fa !== fb) return fa < fb ? -1 : 1;
      return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
    });
    return results;
  },
};

// ---------------------------------------------------------------------------
// digest_show
// Synthesizes the single entity row.
// ---------------------------------------------------------------------------

export const digest_show: RegisteredTool = {
  name: 'digest_show',
  description:
    'Full digest pipeline for one specific entity (file/document): every '
    + 'stage with its status, duration, detail, error. Use this AFTER '
    + 'digest_list when the user wants to drill into one document. '
    + 'Equivalent CLI: raindb-cli digest show <formation> <entityId>.',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      entityId: {
        type: 'string',
        description:
          "The entity's canonical ID. For fdn_documents this is "
          + 'payload.documentId (NOT the dropletId).',
      },
    },
    required: ['formation', 'entityId'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const entityId = stringArg(args, 'entityId');
    if (!formation || !entityId) {
      return { error: 'formation and entityId required' };
    }
    return synthesizeStatus(formation, entityId, ctx.creds, ctx.host);
  },
};

export const digestTools: RegisteredTool[] = [digest_list, digest_show];
