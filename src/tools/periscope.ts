// periscope.ts -- agent tools for periscope (SQL-plane) observability.
//
// Mirrors raindb-phoenix-oc/internal/ai/tools_periscope.go::tenantPeriscopeTools.
// 17 tools, all read-only. Periscope is the parquet/iceberg/duckdb
// SQL plane; these tools surface tier state, snapshots, pools,
// sentinels, scheduled events, and audit/reconcile reports.
//
// Every tool wraps one GraphQL query that mirrors the Go side
// verbatim (selection set + variable shape from
// internal/ops/periscope.go).

import { executeGraphQL } from '../client/graphql.js';
import {
  boolArg,
  intArg,
  stringArg,
} from '../registry/build.js';
import type { RegisteredTool } from '../registry/types.js';

// ---------------------------------------------------------------------------
// GraphQL query strings (verbatim from internal/ops/periscope.go)
// ---------------------------------------------------------------------------

const PERISCOPE_STATUS_QUERY = `
  query PeriscopeStatus {
    periscopeStatus {
      tenantId
      rows {
        formationId
        health
        healthNote
        tiers {
          name state cursor lastCommitMs snapshotCount poolCount
          activePoolCount pendingPoolCount
        }
      }
      healthSummary
    }
  }
`;

const PERISCOPE_FORMATION_LIST_QUERY = `
  query PeriscopeFormationList {
    periscopeFormationList {
      formationId scopeKey tiers tierCount sourceIndex
    }
  }
`;

const PERISCOPE_FORMATION_DESCRIBE_QUERY = `
  query PeriscopeFormationDescribe($formationId: ID!) {
    periscopeFormationDescribe(formationId: $formationId) {
      formationId scopeKey pathTemplate catalogLocation
      indexes { name type strategy template }
      tiers {
        name enabled path retainInputs scopeReduction
        source { type tier index }
        trigger { droplets pools bytes operator delay next tz }
      }
      partition { strategy prefixLength }
      expiration { schedule snapshotRetention }
    }
  }
`;

const PERISCOPE_FORMATION_LINT_QUERY = `
  query PeriscopeFormationLint($formationId: ID!) {
    periscopeFormationLint(formationId: $formationId) {
      formationId passed errors
    }
  }
`;

const PERISCOPE_TIER_LIST_QUERY = `
  query PeriscopeTierList($formationId: ID!) {
    periscopeTierList(formationId: $formationId) {
      name formationId enabled path cursor cursorKey cursorTimeMs
      lastCommitMs snapshotCount poolCount poolBytes activeSentinels
      pendingEvents retainInputs scopeReduction
      source { type tier index }
      trigger { droplets pools bytes operator delay next tz }
    }
  }
`;

const PERISCOPE_TIER_DESCRIBE_QUERY = `
  query PeriscopeTierDescribe($formationId: ID!, $tier: String!) {
    periscopeTierDescribe(formationId: $formationId, tier: $tier) {
      name formationId enabled path cursor cursorKey cursorTimeMs
      lastCommitMs snapshotCount poolCount poolBytes activeSentinels
      pendingEvents retainInputs scopeReduction
      source { type tier index }
      trigger { droplets pools bytes operator delay next tz }
    }
  }
`;

const PERISCOPE_TIER_CURSOR_QUERY = `
  query PeriscopeTierCursor($formationId: ID!, $tier: String!) {
    periscopeTierCursor(formationId: $formationId, tier: $tier) {
      formationId tier cursor cursorKey cursorTimestampMs noCommit
    }
  }
`;

const PERISCOPE_SNAPSHOT_LIST_QUERY = `
  query PeriscopeSnapshotList($formationId: ID!, $tier: String, $limit: Int) {
    periscopeSnapshotList(formationId: $formationId, tier: $tier, limit: $limit) {
      snapshotId parentSnapshotId timestampMs sequenceNumber
      operation manifestList properties
    }
  }
`;

const PERISCOPE_SNAPSHOT_GET_QUERY = `
  query PeriscopeSnapshotGet($formationId: ID!, $snapshotId: String!) {
    periscopeSnapshotGet(formationId: $formationId, snapshotId: $snapshotId) {
      snapshotId parentSnapshotId timestampMs sequenceNumber
      operation manifestList properties
    }
  }
`;

const PERISCOPE_POOL_LIST_QUERY = `
  query PeriscopePoolList($formationId: ID!, $tier: String!, $snapshotId: String, $limit: Int) {
    periscopePoolList(formationId: $formationId, tier: $tier, snapshotId: $snapshotId, limit: $limit) {
      key relativePath tier size lastModified snapshotId
      lowerBoundDropletId upperBoundDropletId
    }
  }
`;

const PERISCOPE_CATALOG_METADATA_QUERY = `
  query PeriscopeCatalogMetadata($formationId: ID!) {
    periscopeCatalogMetadata(formationId: $formationId) {
      formationId version tableUuid location lastUpdatedMs
      currentSnapshotId schemaCount snapshotCount partitionSpecCount
      currentSnapshot {
        snapshotId parentSnapshotId timestampMs sequenceNumber
        operation manifestList properties
      }
    }
  }
`;

const PERISCOPE_CATALOG_TREE_QUERY = `
  query PeriscopeCatalogTree($formationId: ID!) {
    periscopeCatalogTree(formationId: $formationId) {
      formationId bucket prefix totalSize entryCount
      entries { key relativePath size lastModified }
    }
  }
`;

const PERISCOPE_DROPLET_LOCATE_QUERY = `
  query PeriscopeDropletLocate($formationId: ID!, $dropletId: String!) {
    periscopeDropletLocate(formationId: $formationId, dropletId: $dropletId) {
      formationId dropletId
      tiers { tier status cursor cursorTimestampMs }
      pointer { key entityPath scopeKey scopeValue ts }
    }
  }
`;

const PERISCOPE_DROPLET_RESIDUAL_QUERY = `
  query PeriscopeDropletResidual($formationId: ID!, $tier: String!, $limit: Int) {
    periscopeDropletResidual(formationId: $formationId, tier: $tier, limit: $limit) {
      formationId tier cursor count capped
    }
  }
`;

const PERISCOPE_SENTINELS_QUERY = `
  query PeriscopeSentinels($formationId: ID!, $tier: String) {
    periscopeSentinels(formationId: $formationId, tier: $tier) {
      formationId tier scopeHash state scheduledAt scheduledBy
      acquiredAt acquiredBy commitId triggerSource triggerDropletId
      scheduledEventKey key
    }
  }
`;

const PERISCOPE_EVENTS_QUERY = `
  query PeriscopeEvents($formationId: String, $tier: String, $dueOnly: Boolean, $pendingOnly: Boolean) {
    periscopeEvents(formationId: $formationId, tier: $tier, dueOnly: $dueOnly, pendingOnly: $pendingOnly) {
      key eventId formationId tier scopeHash runAfterMs runAfter
      isDue lagSeconds triggerSource triggerDropletId actionType
    }
  }
`;

const PERISCOPE_AUDIT_QUERY = `
  query PeriscopeAudit($formationId: ID!, $tier: String, $limit: Int) {
    periscopeAudit(formationId: $formationId, tier: $tier, limit: $limit) {
      formationId tier s3Droplets snapshotCount totalGap rangesWithGap
      skippedActiveTier skipReason passed
      ranges {
        priorCursor cursor commitTimeMs s3DropletsInRange
        committedInRange gap orphans orphansCapped
      }
    }
  }
`;

const PERISCOPE_RECONCILE_QUERY = `
  query PeriscopeReconcile($formationId: ID!) {
    periscopeReconcile(formationId: $formationId) {
      formationId tiers passed hasFailures inFlight activeTiers
      checks { label tier status observed expected note }
    }
  }
`;

// ---------------------------------------------------------------------------
// Tool definitions. All read-only, all minRole='read', all
// modifiesResource=false. The pattern is uniform: pull args, validate,
// call executeGraphQL, return the projected result field. Result
// shapes are typed loosely (Record<string, unknown> at the top level)
// so callers consume them as JSON; the Go side's typed structs are
// just projection helpers and not part of the wire contract.
// ---------------------------------------------------------------------------

export const periscope_status: RegisteredTool = {
  name: 'periscope_status',
  description:
    "Tier-level state for the current tenant's periscope formations. "
    + 'Values: OK, PENDING, IDLE, STALE, FAILED. '
    + 'Equivalent CLI: raindb-cli periscope status',
  minRole: 'read',
  parameters: { type: 'object' },
  async execute(ctx) {
    const data = await executeGraphQL<{ periscopeStatus: unknown }>(
      PERISCOPE_STATUS_QUERY,
      {},
      ctx.creds,
      ctx.host,
    );
    return data.periscopeStatus;
  },
};

export const periscope_formation_list: RegisteredTool = {
  name: 'periscope_formation_list',
  description:
    'List periscope-enabled formations for the current tenant. '
    + 'Equivalent CLI: raindb-cli periscope formation list',
  minRole: 'read',
  parameters: { type: 'object' },
  async execute(ctx) {
    const data = await executeGraphQL<{ periscopeFormationList: unknown }>(
      PERISCOPE_FORMATION_LIST_QUERY,
      {},
      ctx.creds,
      ctx.host,
    );
    return data.periscopeFormationList;
  },
};

export const periscope_formation_describe: RegisteredTool = {
  name: 'periscope_formation_describe',
  description:
    'Show periscope tier config + cursor + commit state for one formation. '
    + 'Equivalent CLI: raindb-cli periscope formation describe',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: { formation: { type: 'string' } },
    required: ['formation'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    if (!formation) return { error: 'formation required' };
    const data = await executeGraphQL<{ periscopeFormationDescribe: unknown }>(
      PERISCOPE_FORMATION_DESCRIBE_QUERY,
      { formationId: formation },
      ctx.creds,
      ctx.host,
    );
    return data.periscopeFormationDescribe;
  },
};

export const periscope_formation_lint: RegisteredTool = {
  name: 'periscope_formation_lint',
  description:
    'Lint a periscope formation config for common misconfigurations. '
    + 'Equivalent CLI: raindb-cli periscope formation lint',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: { formation: { type: 'string' } },
    required: ['formation'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    if (!formation) return { error: 'formation required' };
    const data = await executeGraphQL<{ periscopeFormationLint: unknown }>(
      PERISCOPE_FORMATION_LINT_QUERY,
      { formationId: formation },
      ctx.creds,
      ctx.host,
    );
    return data.periscopeFormationLint;
  },
};

export const periscope_audit: RegisteredTool = {
  name: 'periscope_audit',
  description:
    'Per-snapshot orphan identification (in-flight aware). '
    + 'Equivalent CLI: raindb-cli periscope audit',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: { formation: { type: 'string' } },
    required: ['formation'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    if (!formation) return { error: 'formation required' };
    const data = await executeGraphQL<{ periscopeAudit: unknown }>(
      PERISCOPE_AUDIT_QUERY,
      { formationId: formation },
      ctx.creds,
      ctx.host,
    );
    return data.periscopeAudit;
  },
};

export const periscope_reconcile: RegisteredTool = {
  name: 'periscope_reconcile',
  description:
    'Arithmetic checks across the tier cascade (droplets -> stream -> river '
    + '-> lake). Equivalent CLI: raindb-cli periscope reconcile',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: { formation: { type: 'string' } },
    required: ['formation'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    if (!formation) return { error: 'formation required' };
    const data = await executeGraphQL<{ periscopeReconcile: unknown }>(
      PERISCOPE_RECONCILE_QUERY,
      { formationId: formation },
      ctx.creds,
      ctx.host,
    );
    return data.periscopeReconcile;
  },
};

export const periscope_tier_list: RegisteredTool = {
  name: 'periscope_tier_list',
  description:
    'Per-tier runtime state for a formation (cursor, commit time, pool count). '
    + 'Equivalent CLI: raindb-cli periscope tier list',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: { formation: { type: 'string' } },
    required: ['formation'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    if (!formation) return { error: 'formation required' };
    const data = await executeGraphQL<{ periscopeTierList: unknown }>(
      PERISCOPE_TIER_LIST_QUERY,
      { formationId: formation },
      ctx.creds,
      ctx.host,
    );
    return data.periscopeTierList;
  },
};

export const periscope_tier_describe: RegisteredTool = {
  name: 'periscope_tier_describe',
  description:
    "One tier's full state (cursor, last commit, pool count, pending count). "
    + 'Equivalent CLI: raindb-cli periscope tier describe',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      tier: {
        type: 'string',
        description: 'tier name (e.g., stream, river, lake)',
      },
    },
    required: ['formation', 'tier'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const tier = stringArg(args, 'tier');
    if (!formation || !tier) {
      return { error: 'formation and tier required' };
    }
    const data = await executeGraphQL<{ periscopeTierDescribe: unknown }>(
      PERISCOPE_TIER_DESCRIBE_QUERY,
      { formationId: formation, tier },
      ctx.creds,
      ctx.host,
    );
    return data.periscopeTierDescribe;
  },
};

export const periscope_tier_cursor: RegisteredTool = {
  name: 'periscope_tier_cursor',
  description:
    'Current read cursor for one tier (where the next pool run will resume). '
    + 'Equivalent CLI: raindb-cli periscope tier cursor',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      tier: { type: 'string' },
    },
    required: ['formation', 'tier'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const tier = stringArg(args, 'tier');
    if (!formation || !tier) {
      return { error: 'formation and tier required' };
    }
    const data = await executeGraphQL<{ periscopeTierCursor: unknown }>(
      PERISCOPE_TIER_CURSOR_QUERY,
      { formationId: formation, tier },
      ctx.creds,
      ctx.host,
    );
    return data.periscopeTierCursor;
  },
};

export const periscope_snapshot_list: RegisteredTool = {
  name: 'periscope_snapshot_list',
  description:
    'Iceberg snapshots for a formation (optionally filtered by tier). '
    + 'Equivalent CLI: raindb-cli periscope snapshot list',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      tier: { type: 'string', description: 'Optional tier filter' },
      limit: { type: 'integer', description: 'Max results (default all)' },
    },
    required: ['formation'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    if (!formation) return { error: 'formation required' };
    const vars: Record<string, unknown> = { formationId: formation };
    const tier = stringArg(args, 'tier');
    if (tier) vars['tier'] = tier;
    const limit = intArg(args, 'limit', 0);
    if (limit > 0) vars['limit'] = limit;
    const data = await executeGraphQL<{ periscopeSnapshotList: unknown }>(
      PERISCOPE_SNAPSHOT_LIST_QUERY,
      vars,
      ctx.creds,
      ctx.host,
    );
    return data.periscopeSnapshotList;
  },
};

export const periscope_snapshot_get: RegisteredTool = {
  name: 'periscope_snapshot_get',
  description:
    "One Iceberg snapshot's full metadata. "
    + 'Equivalent CLI: raindb-cli periscope snapshot get',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      snapshotId: { type: 'string' },
    },
    required: ['formation', 'snapshotId'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const snapshotId = stringArg(args, 'snapshotId');
    if (!formation || !snapshotId) {
      return { error: 'formation and snapshotId required' };
    }
    const data = await executeGraphQL<{ periscopeSnapshotGet: unknown }>(
      PERISCOPE_SNAPSHOT_GET_QUERY,
      { formationId: formation, snapshotId },
      ctx.creds,
      ctx.host,
    );
    return data.periscopeSnapshotGet;
  },
};

export const periscope_pool_list: RegisteredTool = {
  name: 'periscope_pool_list',
  description:
    'Parquet pool files for one tier (optionally filtered to a snapshot). '
    + 'Equivalent CLI: raindb-cli periscope pool list',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      tier: { type: 'string' },
      snapshotId: {
        type: 'string',
        description: 'Optional snapshot filter',
      },
      limit: { type: 'integer' },
    },
    required: ['formation', 'tier'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const tier = stringArg(args, 'tier');
    if (!formation || !tier) {
      return { error: 'formation and tier required' };
    }
    const vars: Record<string, unknown> = { formationId: formation, tier };
    const snapshotId = stringArg(args, 'snapshotId');
    if (snapshotId) vars['snapshotId'] = snapshotId;
    const limit = intArg(args, 'limit', 0);
    if (limit > 0) vars['limit'] = limit;
    const data = await executeGraphQL<{ periscopePoolList: unknown }>(
      PERISCOPE_POOL_LIST_QUERY,
      vars,
      ctx.creds,
      ctx.host,
    );
    return data.periscopePoolList;
  },
};

export const periscope_sentinels_list: RegisteredTool = {
  name: 'periscope_sentinels_list',
  description:
    'Active + scheduled pool sentinels for a formation (optionally one tier). '
    + 'Sentinels mark in-flight or queued pool runs. '
    + 'Equivalent CLI: raindb-cli periscope sentinels list',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      tier: { type: 'string', description: 'Optional tier filter' },
    },
    required: ['formation'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    if (!formation) return { error: 'formation required' };
    const vars: Record<string, unknown> = { formationId: formation };
    const tier = stringArg(args, 'tier');
    if (tier) vars['tier'] = tier;
    const data = await executeGraphQL<{ periscopeSentinels: unknown }>(
      PERISCOPE_SENTINELS_QUERY,
      vars,
      ctx.creds,
      ctx.host,
    );
    return data.periscopeSentinels;
  },
};

export const periscope_events_list: RegisteredTool = {
  name: 'periscope_events_list',
  description:
    'Scheduled periscope.pool events (past-due or pending). '
    + 'Equivalent CLI: raindb-cli periscope events',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: {
        type: 'string',
        description: 'Optional formation filter',
      },
      tier: { type: 'string', description: 'Optional tier filter' },
      dueOnly: { type: 'boolean' },
      pendingOnly: { type: 'boolean' },
    },
  },
  async execute(ctx, args) {
    const vars: Record<string, unknown> = {};
    const formation = stringArg(args, 'formation');
    if (formation) vars['formationId'] = formation;
    const tier = stringArg(args, 'tier');
    if (tier) vars['tier'] = tier;
    if (args['dueOnly'] !== undefined) {
      vars['dueOnly'] = boolArg(args, 'dueOnly', false);
    }
    if (args['pendingOnly'] !== undefined) {
      vars['pendingOnly'] = boolArg(args, 'pendingOnly', false);
    }
    const data = await executeGraphQL<{ periscopeEvents: unknown }>(
      PERISCOPE_EVENTS_QUERY,
      vars,
      ctx.creds,
      ctx.host,
    );
    return data.periscopeEvents;
  },
};

export const periscope_catalog_metadata: RegisteredTool = {
  name: 'periscope_catalog_metadata',
  description:
    'Iceberg catalog metadata pointer (version-hint.text contents + current '
    + 'metadata.json). Equivalent CLI: raindb-cli periscope catalog metadata',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: { formation: { type: 'string' } },
    required: ['formation'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    if (!formation) return { error: 'formation required' };
    const data = await executeGraphQL<{ periscopeCatalogMetadata: unknown }>(
      PERISCOPE_CATALOG_METADATA_QUERY,
      { formationId: formation },
      ctx.creds,
      ctx.host,
    );
    return data.periscopeCatalogMetadata;
  },
};

export const periscope_catalog_tree: RegisteredTool = {
  name: 'periscope_catalog_tree',
  description:
    'Iceberg catalog tree (metadata + manifests + data files). '
    + 'Equivalent CLI: raindb-cli periscope catalog tree',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: { formation: { type: 'string' } },
    required: ['formation'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    if (!formation) return { error: 'formation required' };
    const data = await executeGraphQL<{ periscopeCatalogTree: unknown }>(
      PERISCOPE_CATALOG_TREE_QUERY,
      { formationId: formation },
      ctx.creds,
      ctx.host,
    );
    return data.periscopeCatalogTree;
  },
};

export const periscope_droplet_locate: RegisteredTool = {
  name: 'periscope_droplet_locate',
  description:
    'Find which tier(s) currently hold a droplet ID (based on its pool-file '
    + 'residue). Equivalent CLI: raindb-cli periscope droplet locate',
  minRole: 'read',
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
    const data = await executeGraphQL<{ periscopeDropletLocate: unknown }>(
      PERISCOPE_DROPLET_LOCATE_QUERY,
      { formationId: formation, dropletId },
      ctx.creds,
      ctx.host,
    );
    return data.periscopeDropletLocate;
  },
};

export const periscope_droplet_residual: RegisteredTool = {
  name: 'periscope_droplet_residual',
  description:
    "Residual count of droplet IDs in a tier's pool files (how many droplets "
    + "haven't cascaded yet). Equivalent CLI: raindb-cli periscope droplet "
    + 'residual',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      tier: { type: 'string' },
      limit: { type: 'integer' },
    },
    required: ['formation', 'tier'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const tier = stringArg(args, 'tier');
    if (!formation || !tier) {
      return { error: 'formation and tier required' };
    }
    const vars: Record<string, unknown> = { formationId: formation, tier };
    const limit = intArg(args, 'limit', 0);
    if (limit > 0) vars['limit'] = limit;
    const data = await executeGraphQL<{ periscopeDropletResidual: unknown }>(
      PERISCOPE_DROPLET_RESIDUAL_QUERY,
      vars,
      ctx.creds,
      ctx.host,
    );
    return data.periscopeDropletResidual;
  },
};

/**
 * Per-domain catalog. Order mirrors the Go reference's tool order
 * in tools_periscope.go::tenantPeriscopeTools.
 */
export const periscopeTools: RegisteredTool[] = [
  periscope_status,
  periscope_formation_list,
  periscope_formation_describe,
  periscope_audit,
  periscope_reconcile,
  periscope_tier_list,
  periscope_tier_describe,
  periscope_tier_cursor,
  periscope_snapshot_list,
  periscope_snapshot_get,
  periscope_pool_list,
  periscope_sentinels_list,
  periscope_events_list,
  periscope_catalog_metadata,
  periscope_catalog_tree,
  periscope_droplet_locate,
  periscope_droplet_residual,
  periscope_formation_lint,
];
