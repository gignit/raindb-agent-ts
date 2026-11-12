// tools/index.ts -- per-domain catalogs + the aggregated
// `tenantTools` table.
//
// Host applications compose their own tool array. A host keeps its
// product tools (fdn_search, fdn_get_document, etc.) in its own
// repo and concatenates `tenantTools` to the end:
//
//   const ALL_TOOLS = [...fdnProductTools, ...tenantTools];
//
// Node consumers do the same with their own platform-admin tools.
//
// The aggregator keeps a stable domain order so the model sees a
// consistent surface.

import { cacheTools } from './cache.js';
import { catalogTools } from './catalog.js';
import { chainTools } from './chain.js';
import { configTools } from './config.js';
import { digestTools } from './digest.js';
import { dropletTools } from './droplet.js';
import { entityTools } from './entity.js';
import { formationTools } from './formation.js';
import { indexPageTools } from './index_page.js';
import { keyTools } from './key.js';
import { llmTools } from './llm.js';
import { marketplaceTools } from './marketplace.js';
import { periscopeTools } from './periscope.js';
import { queryTools } from './query.js';
import { relayTools } from './relay.js';
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
export {
  catalog_list,
  catalog_tree,
  catalog_insert,
  catalog_update,
  catalog_delete,
  catalog_transfer,
  catalogTools,
  type CatalogMutationResult,
  type CatalogTransferResult,
  type CatalogListResult,
  type CatalogTreeNode,
} from './catalog.js';
export {
  sql_execute,
  vector_search,
  queryTools,
  type VectorSearchHit,
  type VectorSearchResult,
} from './query.js';
export {
  relay_queue,
  relay_status,
  relay_inspect,
  relay_logs,
  relay_tree,
  relay_entity,
  relayTools,
  type RelayAddress,
  type RelayLogEntry,
  type RelayResult,
  type RelayStatusSummary,
  type RelayInspectView,
  type RelayQueueEntry,
} from './relay.js';
export {
  digest_list,
  digest_show,
  digestTools,
  type ActionStage,
  type DigestEntityStatus,
} from './digest.js';
export {
  periscope_status,
  periscope_formation_list,
  periscope_formation_describe,
  periscope_formation_lint,
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
  periscopeTools,
} from './periscope.js';
export {
  chain_status,
  chain_cardinality,
  chain_audit,
  chainTools,
  type ChainCardinality,
  type ChainSetsInitiator,
  type ChainSet,
  type ChainAuditSetEntry,
  type ChainStatus,
  type ChainAudit,
} from './chain.js';
export {
  index_page,
  indexPageTools,
  type IndexPageResult,
} from './index_page.js';

/**
 * The full tenant tool table. Uses a stable domain order so the
 * surface is identical across raindb-cli and Node consumers.
 *
 * Domain order:
 *   droplet, catalog, entity, sql, formation, cache, periscope,
 *   key, config, usage, relay, digest, llm, marketplace, chain,
 *   index_page.
 *
 * chain + index_page are the chain inspection + read surface,
 * added alongside the orderByDesc:true machinery -- see
 * docs/RAINDB_PATTERNS.md "Newest-First Lists + Polling Updates".
 */
export const tenantTools: RegisteredTool[] = [
  ...dropletTools,
  ...catalogTools,
  ...entityTools,
  ...queryTools, // sql_execute + vector_search
  ...formationTools,
  ...cacheTools,
  ...periscopeTools,
  ...keyTools,
  ...configTools,
  ...usageTools,
  ...relayTools,
  ...digestTools,
  ...llmTools,
  ...marketplaceTools,
  ...chainTools,
  ...indexPageTools,
];
