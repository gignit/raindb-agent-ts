// raindbAi.ts -- default-model resolution against raindb-api's
// llmRegistry GraphQL query.
//
// Historical note: this file used to also export
// `makeRaindbAiClient`, a thin wrapper around openai-node pointed
// at raindb's /v1/* surface. That was removed in the
// goja-host-adapter refactor in favor of the AgentHost surface --
// hosts now expose `chatCompletion` directly, and the Node host
// (src/host/node.ts::makeNodeHost) wraps openai-node internally.
// Callers that need to make a chat completion call call
// `ctx.host.chatCompletion(req)` instead of constructing an
// openai-node client themselves.
//
// resolveDefaultModel + resolveDefaultChatModel survive because they
// resolve via GraphQL (not via the LLM provider's API) and the
// agent loop uses them to pick a chat model when the caller hasn't
// specified one explicitly. Both accept a host so the GraphQL call
// goes through the same AgentHost transport every other call uses.

import { executeGraphQL } from './graphql.js';
import type { AgentHost } from '../host/types.js';
import type { GraphQLOptions } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Default-model resolution via the llmRegistry GraphQL query.
// ---------------------------------------------------------------------------

interface LLMRegistryDefault {
  capability: string;
  modelId: string;
}

interface LLMRegistryResponse {
  llmRegistry: {
    defaults?: LLMRegistryDefault[];
  };
}

const LLM_REGISTRY_QUERY = `
  query LLMRegistry {
    llmRegistry {
      defaults {
        capability
        modelId
      }
    }
  }
`;

interface CachedDefaults {
  capabilities: Record<string, string>;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const defaultsCache = new Map<string, CachedDefaults>();

/**
 * Resolve the canonical default model id for a given capability
 * by querying raindb's `llmRegistry`. Cached per API key for 5
 * minutes; hot-path callers (every agent turn) pay one network
 * round trip per cache TTL.
 *
 * Capabilities the platform commonly registers:
 *   "chat", "embedding", "image", "vision", "code-interpreter".
 *
 * Returns null when the registry has no model satisfying the
 * capability. The caller MUST surface an error -- there's no
 * fallback to invent here per the package's no-fallback discipline.
 *
 * @param creds      Tenant credentials (apiKey + endpoint).
 * @param capability Capability name to resolve.
 * @param host       Optional host adapter for the GraphQL call.
 *                   When omitted, the executeGraphQL fallback
 *                   constructs a Node host inline.
 */
export async function resolveDefaultModel(
  creds: GraphQLOptions,
  capability: string,
  host?: AgentHost,
): Promise<string | null> {
  if (!creds.apiKey) return null;

  const now = Date.now();
  let cached = defaultsCache.get(creds.apiKey);
  if (!cached || cached.expiresAt <= now) {
    try {
      const reg = await executeGraphQL<LLMRegistryResponse>(
        LLM_REGISTRY_QUERY,
        {},
        creds,
        host,
      );
      const map: Record<string, string> = {};
      for (const d of reg.llmRegistry.defaults ?? []) {
        if (d.capability && d.modelId) {
          map[d.capability] = d.modelId;
        }
      }
      cached = { capabilities: map, expiresAt: now + DEFAULT_CACHE_TTL_MS };
      defaultsCache.set(creds.apiKey, cached);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[raindbAi] llmRegistry default-resolution failed:',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }
  return cached.capabilities[capability] ?? null;
}

/**
 * Convenience wrapper for the most-common case. Throws when no
 * chat model resolves -- callers handle the error and surface to
 * the user; the package never picks a model out of thin air.
 */
export async function resolveDefaultChatModel(
  creds: GraphQLOptions,
  host?: AgentHost,
): Promise<string> {
  const m = await resolveDefaultModel(creds, 'chat', host);
  if (!m) {
    throw new Error(
      'resolveDefaultChatModel: raindb registry has no model with chat capability '
      + '(check platform-llm-model + platform-config-llm seeds)',
    );
  }
  return m;
}

/**
 * Test helper -- clear the default-model cache. Hosts shouldn't
 * call this in production. Exported so unit tests can isolate
 * across runs.
 */
export function _resetDefaultModelCache(): void {
  defaultsCache.clear();
}
