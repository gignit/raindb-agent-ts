// chain.ts -- agent tools for reverse-index chain inspection.
//
// Three read-only queries against the RainDB API GraphQL surface
// (equivalent CLI verbs: raindb-cli chain status / cardinality / audit).
//
// When to use: any time the agent is reasoning about a formation
// index that declares orderByDesc:true (the per-index opt-in for
// the chain machinery). Examples:
//   - "is there an in-flight chain.fill on this conversation?"
//     -> chain_status
//   - "how many messages are in this conversation?"
//     -> chain_cardinality (cheaper than a full LIST)
//   - "diagnose a desc-read latency spike or missing-data report"
//     -> chain_audit (--verbose for full sealed-set bundles)
//
// The formation+index must have orderByDesc:true. When it doesn't,
// the server returns a typed error (ErrChainNotEnabled) which
// surfaces here as the tool's error response -- agents should not
// retry against a non-chain-enabled index.
//
// For the asc/desc DATA READ pattern (newest-first iteration +
// asc polling), use the index_page tool family (tools/index_page.ts).
// This file is read-only inspection of the chain's metadata; it
// doesn't read entity payloads.

import { executeGraphQL } from '../client/graphql.js';
import { boolArg, stringArg } from '../registry/build.js';
import type { RegisteredTool } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Wire shapes.
// ---------------------------------------------------------------------------

export interface ChainCardinality {
  sealedCount: number;
  sealedSets: number;
  unsealedTailCount: number;
  total: number;
}

export interface ChainSetsInitiator {
  latestSetId?: string | null;
  lastKeyCursor?: string | null;
  totalObjectCount: number;
}

export interface ChainSet {
  firstKey: string;
  lastKey: string;
  scopeKeys: string[];
  count: number;
  nextSetId?: string | null;
}

export interface ChainAuditSetEntry {
  setId: string;
  firstKey: string;
  lastKey: string;
  count: number;
  nextSetId?: string | null;
  bundle?: ChainSet | null;
}

export interface ChainStatus {
  indexName: string;
  partition: string;
  chainPrefix: string;
  headPresent: boolean;
  headScopeKey?: string | null;
  headEntryPath?: string | null;
  headTsEpochMs?: number | null;
  setsInitiator?: ChainSetsInitiator | null;
  sentinelHeld: boolean;
  sentinelState?: string | null;
  sentinelHolder?: string | null;
  sentinelReadError?: string | null;
  cardinality: ChainCardinality;
}

export interface ChainAudit {
  indexName: string;
  partition: string;
  chainPrefix: string;
  total: number;
  cardinality: ChainCardinality;
  sets: ChainAuditSetEntry[];
  looseFiles: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// GraphQL queries (constants; selection set field order is stable so a
// parity test can byte-compare them)
// ---------------------------------------------------------------------------

const CHAIN_STATUS_QUERY = `
  query ChainStatus($input: ChainTargetInput!) {
    chainStatus(input: $input) {
      indexName partition chainPrefix
      headPresent headScopeKey headEntryPath headTsEpochMs
      setsInitiator { latestSetId lastKeyCursor totalObjectCount }
      sentinelHeld sentinelState sentinelHolder sentinelReadError
      cardinality { sealedCount sealedSets unsealedTailCount total }
    }
  }
`;

const CHAIN_CARDINALITY_QUERY = `
  query ChainCardinality($input: ChainTargetInput!) {
    chainCardinality(input: $input) {
      sealedCount sealedSets unsealedTailCount total
    }
  }
`;

const CHAIN_AUDIT_QUERY = `
  query ChainAudit($input: ChainTargetInput!, $verbose: Boolean) {
    chainAudit(input: $input, verbose: $verbose) {
      indexName partition chainPrefix total
      cardinality { sealedCount sealedSets unsealedTailCount total }
      sets {
        setId firstKey lastKey count nextSetId
        bundle { firstKey lastKey scopeKeys count nextSetId }
      }
      looseFiles
      warnings
    }
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ChainTargetArgs {
  formation: string;
  indexName: string;
  partitionPath?: string;
}

/**
 * Coerce the tool args into the ChainTargetInput shape the GraphQL
 * resolver expects. Returns an error string when required fields
 * are missing, so the caller can short-circuit with a clear message.
 */
function chainTargetInput(args: Record<string, unknown>): ChainTargetArgs | string {
  const formation = stringArg(args, 'formation');
  const indexName = stringArg(args, 'index');
  if (!formation) return 'formation required';
  if (!indexName) return 'index required';
  const partitionPath = stringArg(args, 'partition');
  const out: ChainTargetArgs = { formation, indexName };
  if (partitionPath) out.partitionPath = partitionPath;
  return out;
}

function chainTargetForQuery(t: ChainTargetArgs): Record<string, unknown> {
  const input: Record<string, unknown> = {
    formationId: t.formation,
    indexName: t.indexName,
  };
  if (t.partitionPath !== undefined) input.partitionPath = t.partitionPath;
  return input;
}

// ---------------------------------------------------------------------------
// chain_status
// ---------------------------------------------------------------------------

export const chain_status: RegisteredTool = {
  name: 'chain_status',
  description:
    'Reverse-index chain status snapshot for one partition. Returns '
    + 'head pointer, sets-initiator state, sentinel state (with '
    + 'sentinelReadError populated when the sentinel read failed for '
    + 'reasons other than "absent"), and sealed/unsealed cardinality. '
    + "The formation's index must declare orderByDesc:true; otherwise "
    + 'the call errors. Equivalent CLI: raindb-cli chain status '
    + '--formation X --index Y --partition Z',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: {
        type: 'string',
        description: 'Formation ID (e.g. gb-message, fdn-chat-messages, property)',
      },
      index: {
        type: 'string',
        description: 'Index name on the formation (must be orderByDesc:true)',
      },
      partition: {
        type: 'string',
        description:
          'Partition path for partitioned indexes (e.g. conversationId for '
          + 'gb-message/by-conversation, sessionId for fdn-chat-messages/by-session). '
          + 'Omit for global timelines.',
      },
    },
    required: ['formation', 'index'],
  },
  async execute(ctx, args) {
    const target = chainTargetInput(args);
    if (typeof target === 'string') return { error: target };
    const data = await executeGraphQL<{ chainStatus: ChainStatus | null }>(
      CHAIN_STATUS_QUERY,
      { input: chainTargetForQuery(target) },
      ctx.creds,
      ctx.host,
    );
    if (!data.chainStatus) {
      return { error: `chain status: empty response for ${target.formation}/${target.indexName}` };
    }
    return data.chainStatus;
  },
};

// ---------------------------------------------------------------------------
// chain_cardinality
// ---------------------------------------------------------------------------

export const chain_cardinality: RegisteredTool = {
  name: 'chain_cardinality',
  description:
    'Reverse-index chain cardinality breakdown only (cheaper than '
    + 'chain_status; omits head/sentinel reads). Returns sealedCount, '
    + 'sealedSets, unsealedTailCount, total. Equivalent CLI: raindb-cli '
    + 'chain cardinality --formation X --index Y --partition Z',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string', description: 'Formation ID' },
      index: { type: 'string', description: 'Index name (orderByDesc:true)' },
      partition: {
        type: 'string',
        description: 'Partition path; omit for global timelines.',
      },
    },
    required: ['formation', 'index'],
  },
  async execute(ctx, args) {
    const target = chainTargetInput(args);
    if (typeof target === 'string') return { error: target };
    const data = await executeGraphQL<{ chainCardinality: ChainCardinality | null }>(
      CHAIN_CARDINALITY_QUERY,
      { input: chainTargetForQuery(target) },
      ctx.creds,
      ctx.host,
    );
    if (!data.chainCardinality) {
      return { error: `chain cardinality: empty response for ${target.formation}/${target.indexName}` };
    }
    return data.chainCardinality;
  },
};

// ---------------------------------------------------------------------------
// chain_audit
// ---------------------------------------------------------------------------

export const chain_audit: RegisteredTool = {
  name: 'chain_audit',
  description:
    'Reverse-index chain full audit: walks every sealed set from '
    + 'initiator.latestSetId following nextSetId pointers, plus a '
    + 'loose-file scan under the chain prefix. Returns concise set '
    + 'summaries; pass verbose:true for full ChainSet bundles. Non-'
    + 'fatal observations (dangling NextSetID, safety cap, loose-file '
    + 'LIST errors) surface as warnings. Equivalent CLI: raindb-cli '
    + 'chain audit --formation X --index Y --partition Z [--verbose]',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string', description: 'Formation ID' },
      index: { type: 'string', description: 'Index name (orderByDesc:true)' },
      partition: {
        type: 'string',
        description: 'Partition path; omit for global timelines.',
      },
      verbose: {
        type: 'boolean',
        description: 'Include full ChainSet bundles per set entry.',
      },
    },
    required: ['formation', 'index'],
  },
  async execute(ctx, args) {
    const target = chainTargetInput(args);
    if (typeof target === 'string') return { error: target };
    const verbose = boolArg(args, 'verbose', false);
    const data = await executeGraphQL<{ chainAudit: ChainAudit | null }>(
      CHAIN_AUDIT_QUERY,
      { input: chainTargetForQuery(target), verbose },
      ctx.creds,
      ctx.host,
    );
    if (!data.chainAudit) {
      return { error: `chain audit: empty response for ${target.formation}/${target.indexName}` };
    }
    return data.chainAudit;
  },
};

export const chainTools: RegisteredTool[] = [
  chain_status,
  chain_cardinality,
  chain_audit,
];
