// entity.ts -- agent tools for entity-lifecycle primitives.
//
// Mirrors raindb-phoenix-oc/internal/ai/tools_entity.go::tenantEntityTools.
// 6 tools: 1 read + 5 mutating. Lifecycle covers tag/untag (S3
// object tags), expiration scheduling (lifecycle-policy driven),
// and the immediate force-expire shortcut.

import { executeGraphQL } from '../client/graphql.js';
import {
  intArg,
  objectArg,
  stringArg,
  stringSliceArg,
} from '../registry/build.js';
import type { RegisteredTool } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface EntityVersion {
  dropletId: string;
  key: string;
  versionLabel?: string;
}

interface EntityActionResult {
  formationId: string;
  scopeValue: string;
  success: boolean;
}

const TAG_ENTITY_MUTATION = `
  mutation TagEntity($input: TagEntityInput!) {
    tagEntity(input: $input) {
      formationId
      scopeValue
      success
    }
  }
`;

const UNTAG_ENTITY_MUTATION = `
  mutation UntagEntity($input: UntagEntityInput!) {
    untagEntity(input: $input) {
      formationId
      scopeValue
      success
    }
  }
`;

const EXPIRE_DROPLET_MUTATION = `
  mutation ExpireDroplet($input: ExpireDropletInput!) {
    expireDroplet(input: $input) {
      formationId
      scopeValue
      success
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
      totalCount
    }
  }
`;

// ---------------------------------------------------------------------------
// entity_version_history -- Go ref: tools_entity.go (lines 17-41)
//   + ops/entity.go::EntityVersionHistory (lines 162-200)
//
// The Go op walks ALL S3 keys under entities/<formation>/<scope>/
// and projects each *.json filename to a dropletId. We mirror via
// the listKeys GraphQL query (no formationId, raw prefix), reading
// pages until exhausted and projecting in TS.
// ---------------------------------------------------------------------------

export const entity_version_history: RegisteredTool = {
  name: 'entity_version_history',
  description:
    'List every droplet version for an entity (newest first). '
    + 'Equivalent CLI: raindb-cli entity version-history',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      scope: {
        type: 'string',
        description: 'Scope value identifying the entity',
      },
      versionField: {
        type: 'string',
        description: 'Optional field name to project (default empty)',
      },
    },
    required: ['formation', 'scope'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const scope = stringArg(args, 'scope');
    if (!formation || !scope) {
      return { error: 'formation and scope required' };
    }
    const prefix = `entities/${formation}/${scope}/`;
    const allKeys: string[] = [];
    let cursor: string | undefined;
    while (true) {
      const input: Record<string, unknown> = {
        prefix,
        pageSize: 1000,
      };
      if (cursor) input['cursor'] = cursor;
      const data = await executeGraphQL<{
        listKeys: {
          keys: Array<{ key: string }>;
          nextCursor?: string | null;
          hasMore: boolean;
        };
      }>(LIST_KEYS_QUERY, { input }, ctx.creds, ctx.host);
      const page = data.listKeys;
      for (const k of page.keys ?? []) allKeys.push(k.key);
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    // Project to EntityVersion[]: keep only *.json keys, derive
    // dropletId from the basename. Mirrors ops/entity.go:177-198.
    const versions: EntityVersion[] = [];
    for (const key of allKeys) {
      if (!key.endsWith('.json')) continue;
      const parts = key.split('/');
      if (parts.length < 2) continue;
      const filename = parts[parts.length - 1]!;
      const dropletId = filename.slice(0, -'.json'.length);
      versions.push({ dropletId, key });
    }
    // Reverse so newest-first (mirrors Go op lines 196-198).
    versions.reverse();
    return versions;
  },
};

// ---------------------------------------------------------------------------
// entity_tag -- Go ref: tools_entity.go (lines 42-72)
//   + ops/entity.go::TagEntity (lines 60-95)
// ---------------------------------------------------------------------------

export const entity_tag: RegisteredTool = {
  name: 'entity_tag',
  description:
    'Apply S3 tag key=value pairs to every key of an entity. '
    + 'Equivalent CLI: raindb-cli entity tag',
  minRole: 'write',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      scope: { type: 'string' },
      tags: {
        type: 'object',
        description: 'Map of tag key to value',
      },
    },
    required: ['formation', 'scope', 'tags'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const scope = stringArg(args, 'scope');
    const rawTags = objectArg(args, 'tags');
    if (!formation || !scope || !rawTags) {
      return { error: 'formation, scope, tags required' };
    }
    // Coerce to map[string]string -- silently drop non-string values
    // to mirror the Go side's behavior (tools_entity.go:62-66).
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawTags)) {
      if (typeof v === 'string') tags[k] = v;
    }
    if (Object.keys(tags).length === 0) {
      return { error: 'tags must contain at least one string-valued entry' };
    }
    const data = await executeGraphQL<{
      tagEntity: EntityActionResult;
    }>(
      TAG_ENTITY_MUTATION,
      { input: { formationId: formation, scopeValue: scope, tags } },
      ctx.creds,
      ctx.host,
    );
    if (!data.tagEntity.success) {
      return { error: 'tagEntity: server returned success=false' };
    }
    return { tagged: Object.keys(tags).length };
  },
};

// ---------------------------------------------------------------------------
// entity_untag -- Go ref: tools_entity.go (lines 73-97)
//   + ops/entity.go::UntagEntity (lines 99-130)
// ---------------------------------------------------------------------------

export const entity_untag: RegisteredTool = {
  name: 'entity_untag',
  description:
    'Remove the given tag keys from every key of an entity. '
    + 'Equivalent CLI: raindb-cli entity untag',
  minRole: 'write',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      scope: { type: 'string' },
      tagKeys: {
        type: 'array',
        description: 'Tag keys to remove',
        items: { type: 'string' },
      },
    },
    required: ['formation', 'scope', 'tagKeys'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const scope = stringArg(args, 'scope');
    const tagKeys = stringSliceArg(args, 'tagKeys');
    if (!formation || !scope || tagKeys.length === 0) {
      return { error: 'formation, scope, tagKeys required' };
    }
    const data = await executeGraphQL<{
      untagEntity: EntityActionResult;
    }>(
      UNTAG_ENTITY_MUTATION,
      { input: { formationId: formation, scopeValue: scope, tagKeys } },
      ctx.creds,
      ctx.host,
    );
    if (!data.untagEntity.success) {
      return { error: 'untagEntity: server returned success=false' };
    }
    return { untagged: tagKeys.length };
  },
};

// ---------------------------------------------------------------------------
// entity_mark_for_expiration -- Go ref: tools_entity.go (lines 98-122)
//   + ops/entity.go::MarkForExpiration (lines 136-144)
//
// Wraps tagEntity with a synthetic 'expire-after-days' tag.
// ---------------------------------------------------------------------------

export const entity_mark_for_expiration: RegisteredTool = {
  name: 'entity_mark_for_expiration',
  description:
    "Tag the entity for lifecycle-policy expiry after N days. S3's "
    + 'lifecycle rules then physically delete matching keys. Equivalent '
    + 'CLI: raindb-cli entity mark-for-expiration',
  minRole: 'write',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      scope: { type: 'string' },
      days: {
        type: 'integer',
        description: 'Days until expiry (must be positive)',
      },
    },
    required: ['formation', 'scope', 'days'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const scope = stringArg(args, 'scope');
    const days = intArg(args, 'days', 0);
    if (!formation || !scope || days <= 0) {
      return { error: 'formation, scope, days (>0) required' };
    }
    const data = await executeGraphQL<{
      tagEntity: EntityActionResult;
    }>(
      TAG_ENTITY_MUTATION,
      {
        input: {
          formationId: formation,
          scopeValue: scope,
          tags: { 'expire-after-days': String(days) },
        },
      },
      ctx.creds,
      ctx.host,
    );
    if (!data.tagEntity.success) {
      return { error: 'tagEntity: server returned success=false' };
    }
    return { days };
  },
};

// ---------------------------------------------------------------------------
// entity_cancel_expiration -- Go ref: tools_entity.go (lines 123-145)
//   + ops/entity.go::CancelExpiration (lines 148-150)
// ---------------------------------------------------------------------------

export const entity_cancel_expiration: RegisteredTool = {
  name: 'entity_cancel_expiration',
  description:
    'Remove the expire-after-days tag (cancels scheduled lifecycle '
    + 'expiry). Equivalent CLI: raindb-cli entity cancel-expiration',
  minRole: 'write',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      scope: { type: 'string' },
    },
    required: ['formation', 'scope'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const scope = stringArg(args, 'scope');
    if (!formation || !scope) {
      return { error: 'formation and scope required' };
    }
    const data = await executeGraphQL<{
      untagEntity: EntityActionResult;
    }>(
      UNTAG_ENTITY_MUTATION,
      {
        input: {
          formationId: formation,
          scopeValue: scope,
          tagKeys: ['expire-after-days'],
        },
      },
      ctx.creds,
      ctx.host,
    );
    if (!data.untagEntity.success) {
      return { error: 'untagEntity: server returned success=false' };
    }
    return { cancelled: true };
  },
};

// ---------------------------------------------------------------------------
// entity_expire -- Go ref: tools_entity.go (lines 146-168)
//   + ops/entity.go::ExpireDroplet (lines 28-56)
//
// Hard delete -- not lifecycle-policy. minRole=admin per
// the M2 checklist (destructive shortcut).
// ---------------------------------------------------------------------------

export const entity_expire: RegisteredTool = {
  name: 'entity_expire',
  description:
    'Immediately force-delete the latest droplet for an entity (hard '
    + 'delete; does NOT wait for lifecycle policy). Equivalent CLI: '
    + 'raindb-cli entity expire',
  minRole: 'admin',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      scope: { type: 'string' },
    },
    required: ['formation', 'scope'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const scope = stringArg(args, 'scope');
    if (!formation || !scope) {
      return { error: 'formation and scope required' };
    }
    const data = await executeGraphQL<{
      expireDroplet: EntityActionResult;
    }>(
      EXPIRE_DROPLET_MUTATION,
      { input: { formationId: formation, scopeValue: scope } },
      ctx.creds,
      ctx.host,
    );
    if (!data.expireDroplet.success) {
      return { error: 'expireDroplet: server returned success=false' };
    }
    return { expired: true };
  },
};

export const entityTools: RegisteredTool[] = [
  entity_version_history,
  entity_tag,
  entity_untag,
  entity_mark_for_expiration,
  entity_cancel_expiration,
  entity_expire,
];
