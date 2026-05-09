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

export const VERSION = '0.1.0';

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
  droplet_create,
  dropletTools,
  type WriteResult,

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

  // Aggregated
  tenantTools,
} from './tools/index.js';
