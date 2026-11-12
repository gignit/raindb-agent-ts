// catalog.ts -- agent tools for catalog primitives.
//
// 6 tools: 2 read + 4 mutating. Catalog is RainDB's hierarchical
// entry-list primitive (the foundation under fdn-folders, etc.).

import { executeGraphQL } from '../client/graphql.js';
import {
  intArg,
  objectArg,
  stringArg,
} from '../registry/build.js';
import type { RegisteredTool } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Wire shapes.
// ---------------------------------------------------------------------------

export interface CatalogMutationResult {
  dropletId: string;
  scopeValue: string;
  entry?: Record<string, unknown> | null;
  warnings: string[];
}

export interface CatalogTransferResult {
  targetDropletId: string;
  sourceDropletId: string;
  entry?: Record<string, unknown> | null;
  warnings: string[];
}

export interface CatalogListResult {
  entries: Record<string, unknown>[];
}

export interface CatalogTreeNode {
  catalogId: string;
  displayName: string;
  entries: Record<string, unknown>[];
  children?: CatalogTreeNode[];
}

const CATALOG_LIST_QUERY = `
  query CatalogList($input: CatalogListInput!) {
    catalogList(input: $input) {
      entries
    }
  }
`;

const CATALOG_TREE_QUERY = `
  query CatalogTree($input: CatalogTreeInput!) {
    catalogTree(input: $input) {
      catalogId
      displayName
      entries
      children {
        catalogId
        displayName
        entries
      }
    }
  }
`;

const CATALOG_INSERT_MUTATION = `
  mutation CatalogInsert($input: CatalogInsertInput!) {
    catalogInsert(input: $input) {
      dropletId
      scopeValue
      entry
      warnings
    }
  }
`;

const CATALOG_UPDATE_MUTATION = `
  mutation CatalogUpdate($input: CatalogUpdateInput!) {
    catalogUpdate(input: $input) {
      dropletId
      scopeValue
      entry
      warnings
    }
  }
`;

const CATALOG_DELETE_MUTATION = `
  mutation CatalogDelete($input: CatalogDeleteInput!) {
    catalogDelete(input: $input) {
      dropletId
      scopeValue
      entry
      warnings
    }
  }
`;

const CATALOG_TRANSFER_MUTATION = `
  mutation CatalogTransfer($input: CatalogTransferInput!) {
    catalogTransfer(input: $input) {
      targetDropletId
      sourceDropletId
      entry
      warnings
    }
  }
`;

// ---------------------------------------------------------------------------
// catalog_list
// ---------------------------------------------------------------------------

export const catalog_list: RegisteredTool = {
  name: 'catalog_list',
  description:
    "List catalog entries under a formation's catalog scope. "
    + 'Equivalent CLI: raindb-cli catalog list',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      catalogScope: { type: 'string' },
    },
    required: ['formation', 'catalogScope'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const catalogScope = stringArg(args, 'catalogScope');
    if (!formation || !catalogScope) {
      return { error: 'formation and catalogScope required' };
    }
    const data = await executeGraphQL<{ catalogList: CatalogListResult }>(
      CATALOG_LIST_QUERY,
      {
        input: {
          formationId: formation,
          catalogScopeValue: catalogScope,
        },
      },
      ctx.creds,
      ctx.host,
    );
    return data.catalogList;
  },
};

// ---------------------------------------------------------------------------
// catalog_tree
// ---------------------------------------------------------------------------

export const catalog_tree: RegisteredTool = {
  name: 'catalog_tree',
  description:
    'Return the catalog tree rooted at the given scope up to maxDepth. '
    + 'Equivalent CLI: raindb-cli catalog tree',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      catalogScope: { type: 'string' },
      maxDepth: {
        type: 'integer',
        description: 'Tree depth cap (default 5)',
      },
    },
    required: ['formation', 'catalogScope'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const catalogScope = stringArg(args, 'catalogScope');
    if (!formation || !catalogScope) {
      return { error: 'formation and catalogScope required' };
    }
    const maxDepth = intArg(args, 'maxDepth', 5);
    const input: Record<string, unknown> = {
      formationId: formation,
      catalogScopeValue: catalogScope,
    };
    if (maxDepth > 0) input['maxDepth'] = maxDepth;
    const data = await executeGraphQL<{ catalogTree: CatalogTreeNode | null }>(
      CATALOG_TREE_QUERY,
      { input },
      ctx.creds,
      ctx.host,
    );
    if (!data.catalogTree) {
      return { error: `catalog not found: ${catalogScope}` };
    }
    return data.catalogTree;
  },
};

// ---------------------------------------------------------------------------
// catalog_insert
// ---------------------------------------------------------------------------

export const catalog_insert: RegisteredTool = {
  name: 'catalog_insert',
  description:
    "Insert a new entry into a formation's catalog. Run formation.describe "
    + "first to learn the catalog's entry schema (entries field, ref key). "
    + 'Equivalent CLI: raindb-cli catalog insert',
  minRole: 'write',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      catalogScope: { type: 'string' },
      entry: {
        type: 'object',
        description: "Entry object matching the formation's catalog schema",
      },
    },
    required: ['formation', 'catalogScope', 'entry'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const catalogScope = stringArg(args, 'catalogScope');
    const entry = objectArg(args, 'entry');
    if (!formation || !catalogScope || !entry) {
      return { error: 'formation, catalogScope, entry (object) required' };
    }
    const data = await executeGraphQL<{ catalogInsert: CatalogMutationResult }>(
      CATALOG_INSERT_MUTATION,
      {
        input: {
          formationId: formation,
          catalogScopeValue: catalogScope,
          entry,
        },
      },
      ctx.creds,
      ctx.host,
    );
    return data.catalogInsert;
  },
};

// ---------------------------------------------------------------------------
// catalog_update
// ---------------------------------------------------------------------------

export const catalog_update: RegisteredTool = {
  name: 'catalog_update',
  description:
    'Merge changes into an existing catalog entry identified by refValue. '
    + 'Equivalent CLI: raindb-cli catalog update',
  minRole: 'write',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      catalogScope: { type: 'string' },
      refValue: {
        type: 'string',
        description: "Entry ref (the catalog schema's RefKey value)",
      },
      changes: { type: 'object', description: 'Fields to merge' },
    },
    required: ['formation', 'catalogScope', 'refValue', 'changes'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const catalogScope = stringArg(args, 'catalogScope');
    const refValue = stringArg(args, 'refValue');
    const changes = objectArg(args, 'changes');
    if (!formation || !catalogScope || !refValue || !changes) {
      return {
        error: 'formation, catalogScope, refValue, changes (object) required',
      };
    }
    const data = await executeGraphQL<{ catalogUpdate: CatalogMutationResult }>(
      CATALOG_UPDATE_MUTATION,
      {
        input: {
          formationId: formation,
          catalogScopeValue: catalogScope,
          refValue,
          changes,
        },
      },
      ctx.creds,
      ctx.host,
    );
    return data.catalogUpdate;
  },
};

// ---------------------------------------------------------------------------
// catalog_delete
// ---------------------------------------------------------------------------

export const catalog_delete: RegisteredTool = {
  name: 'catalog_delete',
  description:
    'Delete a catalog entry by refValue. '
    + 'Equivalent CLI: raindb-cli catalog delete',
  minRole: 'write',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      catalogScope: { type: 'string' },
      refValue: { type: 'string' },
    },
    required: ['formation', 'catalogScope', 'refValue'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const catalogScope = stringArg(args, 'catalogScope');
    const refValue = stringArg(args, 'refValue');
    if (!formation || !catalogScope || !refValue) {
      return { error: 'formation, catalogScope, refValue required' };
    }
    const data = await executeGraphQL<{ catalogDelete: CatalogMutationResult }>(
      CATALOG_DELETE_MUTATION,
      {
        input: {
          formationId: formation,
          catalogScopeValue: catalogScope,
          refValue,
        },
      },
      ctx.creds,
      ctx.host,
    );
    return data.catalogDelete;
  },
};

// ---------------------------------------------------------------------------
// catalog_transfer
// ---------------------------------------------------------------------------

export const catalog_transfer: RegisteredTool = {
  name: 'catalog_transfer',
  description:
    'Transfer a catalog entry from one scope to another (delete from '
    + 'source, insert into target) atomically. Equivalent CLI: '
    + 'raindb-cli catalog transfer',
  minRole: 'write',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      sourceScope: { type: 'string' },
      targetScope: { type: 'string' },
      refValue: { type: 'string' },
    },
    required: ['formation', 'sourceScope', 'targetScope', 'refValue'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const sourceScope = stringArg(args, 'sourceScope');
    const targetScope = stringArg(args, 'targetScope');
    const refValue = stringArg(args, 'refValue');
    if (!formation || !sourceScope || !targetScope || !refValue) {
      return {
        error: 'formation, sourceScope, targetScope, refValue required',
      };
    }
    const data = await executeGraphQL<{ catalogTransfer: CatalogTransferResult }>(
      CATALOG_TRANSFER_MUTATION,
      {
        input: {
          formationId: formation,
          sourceScopeValue: sourceScope,
          targetScopeValue: targetScope,
          refValue,
        },
      },
      ctx.creds,
      ctx.host,
    );
    return data.catalogTransfer;
  },
};

export const catalogTools: RegisteredTool[] = [
  catalog_list,
  catalog_tree,
  catalog_insert,
  catalog_update,
  catalog_delete,
  catalog_transfer,
];
