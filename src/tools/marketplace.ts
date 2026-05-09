// marketplace.ts -- agent tools for the RainDB marketplace
// (vendor/pack browsing).
//
// Mirrors raindb-phoenix-oc/internal/ai/tools_marketplace.go. Tool
// names + parameters match exactly so the model sees a
// substitutable surface across the Go (raindb-cli) and TS portals.
//
// Milestone 1 ships only `pack_list` as a read-only pilot. The
// remaining marketplace tools (pack_info, pack_get, pack_features,
// vendor_list, vendor_info) land in Milestone 2 alongside the
// rest of the catalog. pack_install is intentionally NOT ported
// to the shared package: it writes to the operator's filesystem,
// which only the CLI host has. Portal hosts can implement an
// equivalent that publishes the pack's formations to the user's
// project (a substantial product feature scoped per-host).

import { executeGraphQL } from '../client/graphql.js';
import {
  intArg,
  stringArg,
} from '../registry/build.js';
import type { RegisteredTool } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Wire shapes (mirror raindb-phoenix-oc/internal/ops/marketplace.go)
// ---------------------------------------------------------------------------

const PACK_FORMATION = 'platform_marketplace_pack';

interface PackPayload {
  packId?: string;
  vendor?: string;
  packName?: string;
  version?: string;
  vendorPackKey?: string;
  vendorPackVersion?: string;
  packGroup?: string;
  title?: string;
  displayName?: string;
  description?: string;
  category?: string;
  subcategory?: string;
  tags?: string[];
  icon?: string;
  license?: string;
  deprecated?: boolean;
  usageIntent?: string;
  totalFiles?: number;
  totalLoc?: number;
  tokenEstimate?: number;
  publishedAt?: string;
  updatedAt?: string;
}

/** Public summary projection returned by `pack_list`. */
export interface PackSummary {
  packId: string;
  vendor: string;
  packName: string;
  version: string;
  vendorPackKey: string;
  vendorPackVersion: string;
  packGroup: string;
  title: string;
  displayName: string;
  description: string;
  category: string;
  subcategory: string;
  tags: string[];
  icon: string;
  license: string;
  deprecated: boolean;
  usageIntent: string;
  totalFiles: number;
  totalLoc: number;
  tokenEstimate: number;
  publishedAt: string;
  updatedAt: string;
}

interface DropletEnvelope {
  dropletId: string;
  formationId: string;
  schemaVersion: number;
  ts: string;
  author: string;
  payload: PackPayload;
}

interface ListDropletsResponse {
  listDroplets: {
    droplets: DropletEnvelope[];
    nextCursor?: string | null;
    hasMore: boolean;
  };
}

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

// ---------------------------------------------------------------------------
// Filter implementation (mirror of ops/marketplace.go::PackListFilter.matches)
// ---------------------------------------------------------------------------

interface ParsedFilter {
  vendor: string;
  category: string;
  usageIntent: string;
  search: string;
  pageSize: number;
}

function packMatches(p: PackSummary, f: ParsedFilter): boolean {
  if (f.vendor && p.vendor !== f.vendor) return false;
  if (f.category && p.category !== f.category) return false;
  if (f.usageIntent && p.usageIntent !== f.usageIntent) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    const haystack = [
      p.title,
      p.displayName,
      p.description,
      p.packName,
      ...p.tags,
    ]
      .filter((s) => typeof s === 'string')
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

function projectPackSummary(payload: PackPayload | null | undefined): PackSummary | null {
  if (!payload || !payload.packId) return null;
  return {
    packId: payload.packId,
    vendor: payload.vendor ?? '',
    packName: payload.packName ?? '',
    version: payload.version ?? '',
    vendorPackKey: payload.vendorPackKey ?? '',
    vendorPackVersion: payload.vendorPackVersion ?? '',
    packGroup: payload.packGroup ?? '',
    title: payload.title ?? '',
    displayName: payload.displayName ?? '',
    description: payload.description ?? '',
    category: payload.category ?? '',
    subcategory: payload.subcategory ?? '',
    tags: Array.isArray(payload.tags) ? payload.tags.slice() : [],
    icon: payload.icon ?? '',
    license: payload.license ?? '',
    deprecated: Boolean(payload.deprecated),
    usageIntent: payload.usageIntent ?? '',
    totalFiles: typeof payload.totalFiles === 'number' ? payload.totalFiles : 0,
    totalLoc: typeof payload.totalLoc === 'number' ? payload.totalLoc : 0,
    tokenEstimate: typeof payload.tokenEstimate === 'number' ? payload.tokenEstimate : 0,
    publishedAt: payload.publishedAt ?? '',
    updatedAt: payload.updatedAt ?? '',
  };
}

// ---------------------------------------------------------------------------
// pack_list -- Go reference: tools_marketplace.go::tenantMarketplaceTools
// pack_list entry (lines 32-64). Filter shape: ops/marketplace.go::
// PackListFilter (lines 150-156). Implementation logic: ops/marketplace.go::
// PackList (lines 241-284).
// ---------------------------------------------------------------------------

export const pack_list: RegisteredTool = {
  name: 'pack_list',
  description:
    'List vendor-published packs in the marketplace. Each pack is a self-contained '
    + 'bundle (README + formation configs + schemas + code samples) the agent can '
    + 'inspect or install. START HERE when the user asks how to do something in '
    + 'raindb that you don\'t already know. Filter by vendor, category, usageIntent, '
    + 'or free-text search. Equivalent CLI: raindb-cli pack list.',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      vendor: { type: 'string', description: "Filter by vendor id (e.g. 'raindb')." },
      category: { type: 'string', description: "Filter by category (e.g. 'social', 'finance')." },
      usageIntent: {
        type: 'string',
        description: 'Filter by intent: example | reference | pattern | production | experimental.',
      },
      search: {
        type: 'string',
        description: 'Case-insensitive substring against title/description/tags.',
      },
      pageSize: { type: 'integer', description: 'Page size (default 200).' },
    },
  },
  async execute(ctx, args) {
    const filter: ParsedFilter = {
      vendor: stringArg(args, 'vendor'),
      category: stringArg(args, 'category'),
      usageIntent: stringArg(args, 'usageIntent'),
      search: stringArg(args, 'search'),
      pageSize: intArg(args, 'pageSize', 200),
    };
    const pageSize = filter.pageSize > 0 ? filter.pageSize : 200;

    const data = await executeGraphQL<ListDropletsResponse>(
      LIST_DROPLETS_QUERY,
      {
        input: {
          formationId: PACK_FORMATION,
          prefix: `entities/${PACK_FORMATION}/`,
          pageSize,
        },
      },
      ctx.creds,
    );

    // Group by vendorPackKey, keep latest by publishedAt -- mirrors
    // ops/marketplace.go::PackList (lines 257-268).
    const latestByGroup = new Map<string, PackSummary>();
    for (const env of data.listDroplets.droplets ?? []) {
      const summary = projectPackSummary(env.payload);
      if (!summary) continue;
      const key = summary.vendorPackKey;
      const prior = latestByGroup.get(key);
      if (!prior || summary.publishedAt > prior.publishedAt) {
        latestByGroup.set(key, summary);
      }
    }

    const out: PackSummary[] = [];
    for (const summary of latestByGroup.values()) {
      if (packMatches(summary, filter)) out.push(summary);
    }
    out.sort((a, b) => {
      if (a.vendor !== b.vendor) return a.vendor < b.vendor ? -1 : 1;
      return a.packName < b.packName ? -1 : a.packName > b.packName ? 1 : 0;
    });
    return out;
  },
};

// ---------------------------------------------------------------------------
// Pack-detail wire shapes (mirror internal/ops/marketplace.go::Pack +
// PackFile + PackFeature). Pack embeds PackSummary; we flatten + add
// the detail-only fields here.
// ---------------------------------------------------------------------------

export interface PackFeature {
  id: string;
  displayName: string;
  description?: string;
  default: boolean;
  requires: string[];
}

export interface PackFile {
  path: string;
  kind: string;
  feature?: string;
  language?: string;
  loc?: number;
  description?: string;
  contentBytes?: number;
  contentType?: string;
  modTime?: string;
  crc32?: string;
  floatPath?: string;
  floatBucket?: string;
  publicUrl?: string;
}

export interface Pack extends PackSummary {
  triggerPatterns?: string[];
  dependencySignals?: string[];
  readme: string;
  features: PackFeature[];
  files: PackFile[];
  sourceHash?: string;
  packArchivePublicUrl?: string;
  packArchiveContentType?: string;
  packArchiveFilename?: string;
}

export interface VendorSummary {
  vendorId: string;
  displayName: string;
  description?: string;
  icon?: string;
  homepage?: string;
  license?: string;
  verified: boolean;
}

const VENDOR_FORMATION = 'platform_marketplace_vendor';

interface DropletPayload {
  dropletId: string;
  formationId: string;
  ts: string;
  payload: Record<string, unknown> | null;
}

interface ReadLatestResponse {
  readLatest: DropletPayload | null;
}

const READ_LATEST_QUERY = `
  query ReadLatest($input: ReadLatestInput!) {
    readLatest(input: $input) {
      dropletId
      formationId
      ts
      payload
    }
  }
`;

/**
 * Project a pack-formation droplet payload into a typed Pack.
 * Mirrors internal/ops/marketplace.go::projectPack -- JSON
 * round-trip + packId presence check.
 */
function projectPack(payload: Record<string, unknown> | null): Pack | null {
  if (!payload || !payload['packId']) return null;
  // Pull the full Pack shape via a permissive cast; trust the
  // server-side schema validator. Tests exercise the shape so any
  // drift surfaces immediately.
  return payload as unknown as Pack;
}

/**
 * Project a vendor-formation droplet payload. Mirrors
 * internal/ops/marketplace.go::projectVendor -- 7 fields,
 * vendorId required.
 */
function projectVendor(payload: Record<string, unknown> | null): VendorSummary | null {
  if (!payload) return null;
  const vendorId = String(payload['vendorId'] ?? '');
  if (!vendorId) return null;
  return {
    vendorId,
    displayName: String(payload['displayName'] ?? ''),
    description: String(payload['description'] ?? '') || undefined,
    icon: String(payload['icon'] ?? '') || undefined,
    homepage: String(payload['homepage'] ?? '') || undefined,
    license: String(payload['license'] ?? '') || undefined,
    verified: Boolean(payload['verified']),
  };
}

// ---------------------------------------------------------------------------
// pack_info -- Go ref: tools_marketplace.go (lines 65-93)
//   + ops/marketplace.go::PackInfo (lines 291-312)
//
// Reads via readLatest with by-vendor-pack-latest (no version) or
// by-vendor-pack-version (pinned).
// ---------------------------------------------------------------------------

export const pack_info: RegisteredTool = {
  name: 'pack_info',
  description:
    "Read one pack's full record: metadata + README + features + every file inlined. "
    + 'One round-trip returns everything you need to render the pack to the user. '
    + "Pass version='' (or omit) for the latest published version, or pin a specific version. "
    + 'Equivalent CLI: raindb-cli pack info <vendor> <pack> [@<version>].',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      vendor: { type: 'string', description: "Vendor id (e.g. 'raindb')." },
      packName: { type: 'string', description: "Pack name (e.g. 'social')." },
      version: {
        type: 'string',
        description: "Optional version pin (e.g. '1.0.0'); empty = latest.",
      },
    },
    required: ['vendor', 'packName'],
  },
  async execute(ctx, args) {
    const vendor = stringArg(args, 'vendor');
    const packName = stringArg(args, 'packName');
    const version = stringArg(args, 'version');
    if (!vendor || !packName) {
      return { error: 'vendor and packName required' };
    }
    let index: string;
    let scopeValue: string;
    if (!version) {
      index = 'by-vendor-pack-latest';
      scopeValue = `${vendor}-${packName}`;
    } else {
      index = 'by-vendor-pack-version';
      scopeValue = `${vendor}-${packName}-${version}`;
    }
    const data = await executeGraphQL<ReadLatestResponse>(
      READ_LATEST_QUERY,
      {
        input: {
          formationId: PACK_FORMATION,
          indexId: index,
          scopeValue,
        },
      },
      ctx.creds,
    );
    if (!data.readLatest) {
      return { error: `pack not found: ${vendor}/${packName}${version ? '@' + version : ''}` };
    }
    const pack = projectPack(data.readLatest.payload);
    if (!pack) {
      return { error: 'pack payload missing packId' };
    }
    return pack;
  },
};

// ---------------------------------------------------------------------------
// pack_get -- Go ref: tools_marketplace.go (lines 95-122). Alias for
// pack_info (CLI symmetry with `raindb-cli pack get`). Same parameter
// shape, same result.
// ---------------------------------------------------------------------------

export const pack_get: RegisteredTool = {
  name: 'pack_get',
  description:
    'Same data as pack_info; alias for symmetry with the CLI \'pack get\' verb. '
    + 'Equivalent CLI: raindb-cli pack get <vendor> <pack> [@<version>].',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      vendor: { type: 'string' },
      packName: { type: 'string' },
      version: { type: 'string' },
    },
    required: ['vendor', 'packName'],
  },
  execute: pack_info.execute,
};

// ---------------------------------------------------------------------------
// pack_features -- Go ref: tools_marketplace.go (lines 124-148)
//   + ops/marketplace.go::PackFeatures (lines 325-331)
// Reads the same pack record via PackInfo, projects to features[].
// ---------------------------------------------------------------------------

export const pack_features: RegisteredTool = {
  name: 'pack_features',
  description:
    'List the feature options a pack exposes (cargo-style installable units with default + requires). '
    + "Use this BEFORE pack_install to plan a partial install (e.g. 'core,messaging' for raindb/social). "
    + 'Equivalent CLI: raindb-cli pack features <vendor> <pack>.',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      vendor: { type: 'string' },
      packName: { type: 'string' },
    },
    required: ['vendor', 'packName'],
  },
  async execute(ctx, args) {
    const vendor = stringArg(args, 'vendor');
    const packName = stringArg(args, 'packName');
    if (!vendor || !packName) {
      return { error: 'vendor and packName required' };
    }
    const result = await pack_info.execute(ctx, { vendor, packName });
    if (result && typeof result === 'object' && 'error' in result) {
      return result;
    }
    return (result as Pack).features ?? [];
  },
};

// ---------------------------------------------------------------------------
// vendor_list -- Go ref: tools_marketplace.go (lines 189-202)
//   + ops/marketplace.go::VendorList (lines 192-215)
// ---------------------------------------------------------------------------

export const vendor_list: RegisteredTool = {
  name: 'vendor_list',
  description:
    'List vendors publishing in the marketplace (raindb itself + future third parties). '
    + 'Equivalent CLI: raindb-cli vendor list.',
  minRole: 'read',
  parameters: { type: 'object' },
  async execute(ctx) {
    const data = await executeGraphQL<ListDropletsResponse>(
      LIST_DROPLETS_QUERY,
      {
        input: {
          formationId: VENDOR_FORMATION,
          prefix: `entities/${VENDOR_FORMATION}/`,
          pageSize: 200,
        },
      },
      ctx.creds,
    );
    const out: VendorSummary[] = [];
    const seen = new Set<string>();
    for (const env of data.listDroplets.droplets ?? []) {
      const v = projectVendor(env.payload as unknown as Record<string, unknown> | null);
      if (!v || seen.has(v.vendorId)) continue;
      seen.add(v.vendorId);
      out.push(v);
    }
    out.sort((a, b) => (a.vendorId < b.vendorId ? -1 : a.vendorId > b.vendorId ? 1 : 0));
    return out;
  },
};

// ---------------------------------------------------------------------------
// vendor_info -- Go ref: tools_marketplace.go (lines 204-225)
//   + ops/marketplace.go::VendorInfo (lines 218-227)
// ---------------------------------------------------------------------------

export const vendor_info: RegisteredTool = {
  name: 'vendor_info',
  description:
    "Read one vendor's identity record (display name, description, homepage, license, verified). "
    + 'Equivalent CLI: raindb-cli vendor info <vendorId>.',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      vendorId: { type: 'string' },
    },
    required: ['vendorId'],
  },
  async execute(ctx, args) {
    const vendorId = stringArg(args, 'vendorId');
    if (!vendorId) {
      return { error: 'vendorId required' };
    }
    const data = await executeGraphQL<ReadLatestResponse>(
      READ_LATEST_QUERY,
      {
        input: {
          formationId: VENDOR_FORMATION,
          indexId: 'by-id-latest',
          scopeValue: vendorId,
        },
      },
      ctx.creds,
    );
    if (!data.readLatest) {
      return { error: `vendor not found: ${vendorId}` };
    }
    const v = projectVendor(data.readLatest.payload);
    if (!v) {
      return { error: 'vendor payload missing vendorId' };
    }
    return v;
  },
};

/**
 * Per-domain catalog. pack_install is intentionally NOT included --
 * see docs/M2-CHECKLIST.md section J.5 for the deferral rationale
 * (filesystem-bound CLI primitive, portal hosts need a different
 * semantic).
 */
export const marketplaceTools: RegisteredTool[] = [
  pack_list,
  pack_info,
  pack_get,
  pack_features,
  vendor_list,
  vendor_info,
];
