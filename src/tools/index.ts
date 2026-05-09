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

import { cacheTools } from './cache.js';
import { configTools } from './config.js';
import { dropletTools } from './droplet.js';
import { entityTools } from './entity.js';
import { formationTools } from './formation.js';
import { keyTools } from './key.js';
import { llmTools } from './llm.js';
import { marketplaceTools } from './marketplace.js';
import { usageTools } from './usage.js';

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
  droplet_read_current,
  droplet_read_by_id,
  droplet_read_latest,
  droplet_list,
  droplet_keys,
  droplet_create,
  droplet_update,
  droplet_push_public,
  droplet_bulk_create,
  droplet_bulk_update,
  dropletTools,
  type DropletResult,
  type DropletPage,
  type KeyEntry,
  type KeyPage,
  type WriteResult,
  type PushPublicResult,
  type BulkDropletResult,
} from './droplet.js';
export {
  entity_version_history,
  entity_tag,
  entity_untag,
  entity_mark_for_expiration,
  entity_cancel_expiration,
  entity_expire,
  entityTools,
  type EntityVersion,
} from './entity.js';
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
export {
  key_list,
  key_create,
  key_revoke,
  keyTools,
  type APIKeyInfo,
  type APIKeyPage,
  type CreateKeyResult,
  type RevokeKeyResult,
} from './key.js';
export {
  usage_list,
  usage_summary,
  usageTools,
  type UsageEvent,
  type UsageSummaryRow,
} from './usage.js';
export {
  llm_provider_list,
  llm_model_list,
  llm_usage_report_summary,
  llmTools,
  type LLMUsageReportRow,
} from './llm.js';

/**
 * The full tenant tool table. Mirrors the Go aggregator's order so
 * the surface is identical across raindb-cli and the TS portals.
 *
 * Domain order (from raindb-phoenix-oc/internal/ai/tools.go::
 * tenantToolTable):
 *   droplet, catalog, entity, sql, formation, cache, periscope,
 *   key, config, usage, relay, digest, llm, marketplace.
 */
export const tenantTools: RegisteredTool[] = [
  ...dropletTools,
  // catalogTools   -- M2 pending
  ...entityTools,
  // sqlTools       -- M2 pending (sql_execute, vector_search)
  ...formationTools,
  ...cacheTools,
  // periscopeTools -- M2 pending (17 tools)
  ...keyTools,
  ...configTools,
  ...usageTools,
  // relayTools     -- M2 pending
  // digestTools    -- M2 pending
  ...llmTools,
  ...marketplaceTools,
];
