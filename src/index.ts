/**
 * @raindb/agent -- shared TypeScript agent runtime + tool catalog
 * for the RainDB ecosystem.
 *
 * Two consumers: fdn-app (the FDN portal) and raindb-app (the
 * RainDB platform portal). Both import the same agent runtime,
 * the same tenant tool table, and the same system-prompt scaffold
 * so the agent surface stays in lockstep across the two products.
 *
 * The Go agent in raindb-phoenix-oc/internal/ai/ is the reference
 * implementation. This package is its TypeScript mirror. When the
 * two diverge, the Go side wins.
 *
 * THIS FILE IS THE PUBLIC API. Hosts bind to these exports;
 * changing them is a breaking change. Internals under src/ are
 * not exported -- they can iterate freely between releases.
 */

export const VERSION = '0.4.0';

// === Agent runtime ===
export { runAgent } from './loop/index.js';
export type {
  RunAgentOptions,
  AgentResult,
} from './loop/index.js';

// === Registry primitives + types ===
export type {
  RegisteredTool,
  ToolContext,
  ToolRole,
  ToolArgs,
  ToolFn,
  ToolParameters,
  ToolProperty,
  ToolEvent,
  ToolConfirmFn,
  AgentEvent,
  GraphQLOptions,
} from './registry/types.js';

export {
  buildToolDefs,
  defaultRoleAllows,
  findTool,
  toChatTool,
  // arg helpers (re-exported for tool authors composing their own)
  stringArg,
  intArg,
  boolArg,
  stringSliceArg,
  objectArg,
} from './registry/build.js';

// === System prompt scaffold ===
export {
  buildSystemPrompt,
} from './prompts/system.js';
export type {
  SystemPromptOptions,
  SystemPromptBase,
} from './prompts/system.js';

// === Clients (escape hatch for advanced hosts) ===
export {
  executeGraphQL,
  RaindbError,
} from './client/graphql.js';
export {
  executeSQL,
  sqlRowToColumns,
  type SQLResult,
} from './client/sql.js';
export {
  makeRaindbAiClient,
  resolveDefaultModel,
  resolveDefaultChatModel,
} from './client/raindbAi.js';

// === Per-domain tool catalogs ===
export {
  // Marketplace
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

  // Droplet
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

  // Entity
  entity_version_history,
  entity_tag,
  entity_untag,
  entity_mark_for_expiration,
  entity_cancel_expiration,
  entity_expire,
  entityTools,
  type EntityVersion,

  // Formation
  formation_list,
  formation_describe,
  formation_publish,
  formationTools,
  type FormationInfo,
  type FormationDetail,
  type PublishFormationResult,

  // Cache
  cache_stats_my,
  cacheTools,
  type CacheStatsRow,

  // Config
  config_get,
  configTools,
  type RemoteServiceConfig,

  // Key
  key_list,
  key_create,
  key_revoke,
  keyTools,
  type APIKeyInfo,
  type APIKeyPage,
  type CreateKeyResult,
  type RevokeKeyResult,

  // Usage
  usage_list,
  usage_summary,
  usageTools,
  type UsageEvent,
  type UsageSummaryRow,

  // LLM
  llm_provider_list,
  llm_model_list,
  llm_usage_report_summary,
  llmTools,
  type LLMUsageReportRow,

  // Catalog
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

  // Query (sql + vector)
  sql_execute,
  vector_search,
  queryTools,
  type VectorSearchHit,
  type VectorSearchResult,

  // Relay
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

  // Digest
  digest_list,
  digest_show,
  digestTools,
  type ActionStage,
  type DigestEntityStatus,

  // Periscope (17 tools, all read-only)
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

  // Aggregated
  tenantTools,
} from './tools/index.js';
