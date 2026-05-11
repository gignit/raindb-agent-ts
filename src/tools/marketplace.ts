// marketplace.ts -- agent tools for the RainDB marketplace
// (vendor/pack browsing).
//
// Phase 6 of docs/BRIDGE_REFACTOR_PLAN.md in raindb-phoenix-oc:
// marketplace is a PARTNER of the bridge, not a passenger. It
// lives on raindb-app as an anonymous-readable REST API. These
// tools fetch from that REST surface instead of trying to
// listDroplets the platform tenant via per-tenant GraphQL
// credentials -- which fails because the marketplace formations
// aren't bridged to per-tenant tenants.
//
// Decision matrix walk (PROJECT_REQUIREMENTS.md section 1.2):
//
//   Rule 1 (numbered rules): A.2 "no fallbacks" -- marketplaceBaseUrl
//   is required when calling marketplace tools; absence is an
//   explicit error.
//
//   Rule 2 (phoenix pattern): the marketplace REST API on raindb-app
//   is the existing primitive (server/index.js routes
//   /api/marketplace/*). This is what raindb-app's web UI already
//   consumes; we mirror that pattern.
//
//   Rule 5 (default to simpler): HTTP fetch with no auth is
//   structurally simpler than threading per-tenant API keys +
//   ListDroplets + projection mapping. Same payload shape; one
//   round-trip per call.
//
// Mirrors raindb-phoenix-oc/internal/ai/tools_marketplace.go for
// tool names + parameters so the model sees a substitutable
// surface across the Go (raindb-cli) and TS portals.
//
// pack_install is intentionally NOT ported to the shared package:
// it writes to the operator's filesystem, which only the CLI host
// has. Portal hosts can implement an equivalent that publishes
// the pack's formations to the user's project via Genesis seeds
// (a substantial product feature scoped per-host).

import { RaindbError } from '../client/graphql.js';
import {
  stringArg,
} from '../registry/build.js';
import type { RegisteredTool, ToolContext } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Wire shapes (mirror raindb-app's /api/marketplace/* response shapes,
// which are byte-identical to raindb-phoenix-oc/internal/ops/marketplace.go's
// Pack / PackSummary / VendorSummary projections).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// REST transport
// ---------------------------------------------------------------------------

/**
 * Resolve the marketplace base URL from the tool context. Returns
 * either a normalized URL (trailing slash stripped) or an error
 * object the caller surfaces verbatim. Per the "no fallbacks"
 * principle: absence is an explicit error, never a default URL.
 */
function resolveMarketplaceBaseUrl(ctx: ToolContext): string | { error: string } {
  const raw = ctx.marketplaceBaseUrl;
  if (!raw || typeof raw !== 'string' || raw.trim() === '') {
    return {
      error:
        'marketplaceBaseUrl required on ToolContext. The shared package '
        + 'does not read process.env directly; the host (fdn-app, raindb-app, '
        + 'or other) must populate it. Typically: ctx.marketplaceBaseUrl = '
        + 'process.env.RAINDB_API_URL (default http://localhost:8080).',
    };
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Fetch a JSON document from the marketplace REST API on raindb-api.
 * Sends `X-API-Key: <ctx.creds.apiKey>` because raindb-api's
 * authMiddleware gates `/api/marketplace/*` post-S.1 (commit 2ee476a
 * on raindb-phoenix-oc). The caller identity is used for authn /
 * observability only; the actual data source is the marketplace
 * tenant resolved server-side via platform_marketplace_credential.
 *
 * Throws a `RaindbError` on transport failure or non-2xx response so
 * the agent loop can surface a typed error to the model.
 */
async function fetchMarketplace<T>(
  baseUrl: string,
  path: string,
  apiKey: string | undefined,
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey && apiKey.trim() !== '') {
    headers['X-API-Key'] = apiKey;
  }
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers });
  } catch (err) {
    throw new RaindbError(
      `marketplace fetch failed (network): ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      /* ignore */
    }
    throw new RaindbError(
      `marketplace fetch failed (HTTP ${response.status}): ${url}${body ? ': ' + body.slice(0, 200) : ''}`,
      { status: response.status },
    );
  }
  try {
    return (await response.json()) as T;
  } catch (err) {
    throw new RaindbError(
      `marketplace returned non-JSON: ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// pack_list -- GET /api/marketplace/packs[?vendor=...&category=...&...]
// ---------------------------------------------------------------------------

interface PacksResponse {
  tagline?: string;
  packs: PackSummary[];
}

export const pack_list: RegisteredTool = {
  name: 'pack_list',
  description:
    'List vendor-published packs in the marketplace. Each pack is a self-contained '
    + 'bundle (README + formation configs + schemas + code samples) the agent can '
    + 'inspect or install. START HERE when the user asks how to do something in '
    + "raindb that you don't already know. Filter by vendor, category, usageIntent, "
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
    },
  },
  async execute(ctx, args) {
    const base = resolveMarketplaceBaseUrl(ctx);
    if (typeof base !== 'string') return base;

    // Build query string. raindb-app's /api/marketplace/packs accepts
    // vendor, category, usageIntent, search as query params and applies
    // the filtering server-side -- we forward whatever the LLM passed,
    // server is the canonical filter implementation. (Mirrors the
    // "marketplace REST is the partner" Phase 6 decision: don't
    // re-implement filter semantics client-side; defer to server.)
    const qs = new URLSearchParams();
    const vendor = stringArg(args, 'vendor');
    if (vendor) qs.set('vendor', vendor);
    const category = stringArg(args, 'category');
    if (category) qs.set('category', category);
    const usageIntent = stringArg(args, 'usageIntent');
    if (usageIntent) qs.set('usageIntent', usageIntent);
    const search = stringArg(args, 'search');
    if (search) qs.set('search', search);

    const path = `/api/marketplace/packs${qs.size > 0 ? '?' + qs.toString() : ''}`;
    const data = await fetchMarketplace<PacksResponse>(base, path, ctx.creds?.apiKey);
    return data.packs ?? [];
  },
};

// ---------------------------------------------------------------------------
// pack_info -- GET /api/marketplace/packs/:vendor/:packName[?version=...]
// ---------------------------------------------------------------------------

interface PackResponse {
  pack: Pack;
}

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
    const base = resolveMarketplaceBaseUrl(ctx);
    if (typeof base !== 'string') return base;

    const vendor = stringArg(args, 'vendor');
    const packName = stringArg(args, 'packName');
    const version = stringArg(args, 'version');
    if (!vendor || !packName) {
      return { error: 'vendor and packName required' };
    }
    const qs = new URLSearchParams();
    if (version) qs.set('version', version);
    const path = `/api/marketplace/packs/${encodeURIComponent(vendor)}/${encodeURIComponent(packName)}${qs.size > 0 ? '?' + qs.toString() : ''}`;

    let data: PackResponse;
    try {
      data = await fetchMarketplace<PackResponse>(base, path, ctx.creds?.apiKey);
    } catch (err) {
      // 404 surfaces as a typed RaindbError with status=404; convert
      // to the friendlier "pack not found" message the prior GraphQL
      // path returned.
      if (err instanceof RaindbError && err.status === 404) {
        return {
          error: `pack not found: ${vendor}/${packName}${version ? '@' + version : ''}`,
        };
      }
      throw err;
    }
    if (!data.pack) {
      return { error: `pack not found: ${vendor}/${packName}${version ? '@' + version : ''}` };
    }
    return data.pack;
  },
};

// ---------------------------------------------------------------------------
// pack_get -- CLI symmetry alias for pack_info.
// ---------------------------------------------------------------------------

export const pack_get: RegisteredTool = {
  name: 'pack_get',
  description:
    "Same data as pack_info; alias for symmetry with the CLI 'pack get' verb. "
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
// pack_features -- projects pack_info to features[].
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
// vendor_list -- GET /api/marketplace/vendors
// ---------------------------------------------------------------------------

interface VendorsResponse {
  tagline?: string;
  vendors: VendorSummary[];
}

export const vendor_list: RegisteredTool = {
  name: 'vendor_list',
  description:
    'List vendors publishing in the marketplace (raindb itself + future third parties). '
    + 'Equivalent CLI: raindb-cli vendor list.',
  minRole: 'read',
  parameters: { type: 'object' },
  async execute(ctx) {
    const base = resolveMarketplaceBaseUrl(ctx);
    if (typeof base !== 'string') return base;
    const data = await fetchMarketplace<VendorsResponse>(base, '/api/marketplace/vendors', ctx.creds?.apiKey);
    return data.vendors ?? [];
  },
};

// ---------------------------------------------------------------------------
// vendor_info -- GET /api/marketplace/vendors/:vendorId
// ---------------------------------------------------------------------------

interface VendorResponse {
  vendor: VendorSummary;
}

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
    const base = resolveMarketplaceBaseUrl(ctx);
    if (typeof base !== 'string') return base;
    const vendorId = stringArg(args, 'vendorId');
    if (!vendorId) {
      return { error: 'vendorId required' };
    }
    const path = `/api/marketplace/vendors/${encodeURIComponent(vendorId)}`;
    let data: VendorResponse;
    try {
      data = await fetchMarketplace<VendorResponse>(base, path, ctx.creds?.apiKey);
    } catch (err) {
      if (err instanceof RaindbError && err.status === 404) {
        return { error: `vendor not found: ${vendorId}` };
      }
      throw err;
    }
    if (!data.vendor) {
      return { error: `vendor not found: ${vendorId}` };
    }
    return data.vendor;
  },
};

/**
 * Per-domain catalog. pack_install is intentionally NOT included --
 * see docs/M2-CHECKLIST.md section J.5 for the deferral rationale
 * (filesystem-bound CLI primitive, portal hosts need a different
 * semantic; Phase 5 of docs/BRIDGE_REFACTOR_PLAN.md is the
 * Genesis-seed-based replacement).
 */
export const marketplaceTools: RegisteredTool[] = [
  pack_list,
  pack_info,
  pack_get,
  pack_features,
  vendor_list,
  vendor_info,
];
