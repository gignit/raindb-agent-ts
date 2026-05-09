// tools/index.ts -- per-domain catalogs + the aggregated
// `tenantTools` table.
//
// Hosts compose their own tool array. fdn-app keeps its product
// tools (fdn_search, fdn_get_document, etc.) in its own repo and
// concatenates `tenantTools` to the end:
//
//   const ALL_TOOLS = [...fdnProductTools, ...tenantTools];
//
// raindb-app does the same with its own platform-admin tools.
//
// The aggregator mirrors raindb-phoenix-oc/internal/ai/tools.go::
// tenantToolTable (lines 83-100) -- same domain order so the
// model sees a stable surface across Go + TS.
//
// M1 shipped: pack_list + droplet_create.
// M2 in progress -- per-domain landings tracked in
// docs/M2-CHECKLIST.md.

import { cacheTools } from './cache.js';
import { configTools } from './config.js';
import { dropletTools } from './droplet.js';
import { formationTools } from './formation.js';
import { marketplaceTools } from './marketplace.js';

import type { RegisteredTool } from '../registry/types.js';

// Per-domain catalog re-exports.
export {
  pack_list,
  pack_info,
  pack_get,
  pack_features,
  vendor_list,
  vendor_info,
  marketplaceTools,
  type PackSummary,
  type Pack,
  type PackFeature,
  type PackFile,
  type VendorSummary,
} from './marketplace.js';
export {
  droplet_create,
  dropletTools,
  type WriteResult,
} from './droplet.js';
export {
  formation_list,
  formation_describe,
  formation_publish,
  formationTools,
  type FormationInfo,
  type FormationDetail,
  type PublishFormationResult,
} from './formation.js';
export {
  cache_stats_my,
  cacheTools,
  type CacheStatsRow,
} from './cache.js';
export {
  config_get,
  configTools,
  type RemoteServiceConfig,
} from './config.js';

/**
 * The full tenant tool table. Mirrors the Go aggregator's order so
 * the surface is identical across raindb-cli and the TS portals.
 *
 * Domain order (from raindb-phoenix-oc/internal/ai/tools.go::
 * tenantToolTable):
 *   droplet, catalog, entity, sql, formation, cache, periscope,
 *   key, config, usage, relay, digest, llm, marketplace.
 *
 * Domains not yet ported are commented out in slot order so the
 * eventual full list looks identical to the Go side.
 */
export const tenantTools: RegisteredTool[] = [
  ...dropletTools,
  // catalogTools   -- M2 pending
  // entityTools    -- M2 pending
  // sqlTools       -- M2 pending (sql_execute, vector_search)
  ...formationTools,
  ...cacheTools,
  // periscopeTools -- M2 pending
  // keyTools       -- M2 pending
  ...configTools,
  // usageTools     -- M2 pending
  // relayTools     -- M2 pending
  // digestTools    -- M2 pending
  // llmTools       -- M2 pending
  ...marketplaceTools,
];
