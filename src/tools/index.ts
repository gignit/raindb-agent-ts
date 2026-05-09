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
// Milestone 1 ships only the marketplace + droplet pilots. The
// remaining 12 domains (catalog, entity, sql, formation, cache,
// periscope, key, config, usage, relay, digest, llm) land in
// Milestone 2.

import { dropletTools } from './droplet.js';
import { marketplaceTools } from './marketplace.js';

import type { RegisteredTool } from '../registry/types.js';

export {
  pack_list,
  marketplaceTools,
  type PackSummary,
} from './marketplace.js';
export {
  droplet_create,
  dropletTools,
  type WriteResult,
} from './droplet.js';

/**
 * The full tenant tool table. Mirrors the Go aggregator's order so
 * the surface is identical across raindb-cli and the TS portals.
 *
 * Milestone 1 surface: pack_list + droplet_create (the two
 * pilots). Milestone 2 fills in the rest.
 */
export const tenantTools: RegisteredTool[] = [
  ...dropletTools,
  // catalogTools     -- M2
  // entityTools      -- M2
  // sqlTools         -- M2
  // formationTools   -- M2
  // cacheTools       -- M2
  // periscopeTools   -- M2
  // keyTools         -- M2
  // configTools      -- M2
  // usageTools       -- M2
  // relayTools       -- M2
  // digestTools      -- M2
  // llmTools         -- M2
  ...marketplaceTools,
];
