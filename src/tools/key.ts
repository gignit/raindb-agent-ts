// key.ts -- agent tools for tenant API-key management.
//
// Mirrors raindb-phoenix-oc/internal/ai/tools_key.go::tenantKeyTools.
// 3 tools: key_list (read), key_create (admin/mutating; returns
// the plaintext secret EXACTLY ONCE), key_revoke (admin/mutating;
// irreversible).

import { executeGraphQL } from '../client/graphql.js';
import {
  intArg,
  stringArg,
  stringSliceArg,
} from '../registry/build.js';
import type { RegisteredTool } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Wire shapes (mirror internal/ops/key.go)
// ---------------------------------------------------------------------------

export interface APIKeyInfo {
  apiClientId: string;
  tenantId: string;
  scopes: string[];
  createdAt: string;
  expiresAt?: string;
  createdBy?: string;
  lastUsedAt?: string;
}

export interface APIKeyPage {
  keys: APIKeyInfo[];
  nextCursor?: string | null;
  hasMore: boolean;
  totalCount: number;
}

export interface CreateKeyResult {
  apiClientId: string;
  apiKey: string;
  info: APIKeyInfo;
}

export interface RevokeKeyResult {
  apiClientId: string;
  revokedAt?: string;
}

const LIST_API_KEYS_QUERY = `
  query ListAPIKeys($cursor: Cursor, $pageSize: Int) {
    listAPIKeys(cursor: $cursor, pageSize: $pageSize) {
      keys {
        apiClientId
        tenantId
        scopes
        createdAt
        expiresAt
        createdBy
        lastUsedAt
      }
      nextCursor
      hasMore
      totalCount
    }
  }
`;

const CREATE_API_KEY_MUTATION = `
  mutation CreateAPIKey($input: CreateAPIKeyInput!) {
    createAPIKey(input: $input) {
      apiClientId
      apiKey
      info {
        apiClientId
        tenantId
        scopes
        createdAt
        expiresAt
        createdBy
        lastUsedAt
      }
    }
  }
`;

const REVOKE_API_KEY_MUTATION = `
  mutation RevokeAPIKey($apiClientId: String!) {
    revokeAPIKey(apiClientId: $apiClientId) {
      apiClientId
      revokedAt
    }
  }
`;

// ---------------------------------------------------------------------------
// key_list -- Go ref: tools_key.go (lines 22-39)
//   + ops/key.go::ListKeys (lines 62-80)
// ---------------------------------------------------------------------------

export const key_list: RegisteredTool = {
  name: 'key_list',
  description:
    'List API keys for the current tenant. Equivalent CLI: raindb-cli key list',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      cursor: { type: 'string' },
      pageSize: { type: 'integer', description: 'Page size (default 100)' },
    },
  },
  async execute(ctx, args) {
    const cursor = stringArg(args, 'cursor');
    const pageSize = intArg(args, 'pageSize', 100);
    const vars: Record<string, unknown> = {};
    if (cursor) vars['cursor'] = cursor;
    if (pageSize > 0) vars['pageSize'] = pageSize;
    const data = await executeGraphQL<{ listAPIKeys: APIKeyPage }>(
      LIST_API_KEYS_QUERY,
      vars,
      ctx.creds,
    );
    return data.listAPIKeys;
  },
};

// ---------------------------------------------------------------------------
// key_create -- Go ref: tools_key.go (lines 40-63)
//   + ops/key.go::CreateKey (lines 85-105)
//
// minRole=admin per the M2 checklist (key minting is sensitive).
// Returns the plaintext secret in `apiKey` -- callers MUST capture
// it immediately; the server-side store hashes it and never
// surfaces it again.
// ---------------------------------------------------------------------------

export const key_create: RegisteredTool = {
  name: 'key_create',
  description:
    'Create a new API key with the given scopes. Returns the plaintext '
    + 'secret exactly once; capture it immediately. Equivalent CLI: '
    + 'raindb-cli key create',
  minRole: 'admin',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      scopes: {
        type: 'array',
        description: 'Scope names (e.g., read, write, admin)',
        items: { type: 'string' },
      },
      expiresAt: {
        type: 'string',
        description: 'Optional RFC3339 expiry',
      },
    },
    required: ['scopes'],
  },
  async execute(ctx, args) {
    const scopes = stringSliceArg(args, 'scopes');
    if (scopes.length === 0) {
      return { error: 'scopes required' };
    }
    const input: Record<string, unknown> = { scopes };
    const expiresAt = stringArg(args, 'expiresAt');
    if (expiresAt) input['expiresAt'] = expiresAt;
    const data = await executeGraphQL<{ createAPIKey: CreateKeyResult }>(
      CREATE_API_KEY_MUTATION,
      { input },
      ctx.creds,
    );
    return data.createAPIKey;
  },
};

// ---------------------------------------------------------------------------
// key_revoke -- Go ref: tools_key.go (lines 64-85)
//   + ops/key.go::RevokeKey (lines 108-122)
// ---------------------------------------------------------------------------

export const key_revoke: RegisteredTool = {
  name: 'key_revoke',
  description:
    'Revoke an API key by its client ID. IRREVERSIBLE. Equivalent CLI: '
    + 'raindb-cli key revoke',
  minRole: 'admin',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      apiClientId: { type: 'string' },
    },
    required: ['apiClientId'],
  },
  async execute(ctx, args) {
    const apiClientId = stringArg(args, 'apiClientId');
    if (!apiClientId) {
      return { error: 'apiClientId required' };
    }
    const data = await executeGraphQL<{ revokeAPIKey: RevokeKeyResult }>(
      REVOKE_API_KEY_MUTATION,
      { apiClientId },
      ctx.creds,
    );
    return data.revokeAPIKey;
  },
};

export const keyTools: RegisteredTool[] = [
  key_list,
  key_create,
  key_revoke,
];
