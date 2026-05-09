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

/**
 * Per-domain catalog. The aggregator in `tools/index.ts`
 * concatenates this with the other domain arrays to assemble the
 * full `tenantTools` table.
 */
export const marketplaceTools: RegisteredTool[] = [pack_list];
