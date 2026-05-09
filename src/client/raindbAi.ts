// raindbAi.ts -- canonical openai-node client pointed at raindb's
// /v1/* surface.
//
// Extracted from fdn-app/server/src/raindbAi.ts. Same wire
// contract: openai-node sends `Authorization: Bearer <apiKey>`,
// raindb-api accepts that AND `X-API-Key: <apiKey>` for legacy
// callers. The library uses Bearer; raindb-api's auth middleware
// sniffs the rdb_ prefix and routes through the API-key validator.
//
// The package never reads process.env -- callers (fdn-app,
// raindb-app, future consumers) pass apiKey + endpoint explicitly
// per the leaf-layer rule.

import OpenAI from 'openai';

import type { GraphQLOptions } from '../registry/types.js';
import { executeGraphQL } from './graphql.js';

/**
 * Derive the openai-node baseURL from the GraphQL endpoint.
 *
 * raindb-api hosts both the GraphQL surface (`/graphql`) and the
 * openai-spec REST surface (`/v1/*`) on the same origin. Hosts
 * conventionally pass `creds.endpoint` as the GraphQL URL; this
 * helper strips the trailing `/graphql` and appends `/v1` to
 * produce the openai-node-friendly base.
 */
function deriveOpenAIBaseURL(graphqlEndpoint: string): string {
  return graphqlEndpoint.replace(/\/graphql\/?$/, '') + '/v1';
}

/**
 * Construct an openai-node client pointed at raindb's /v1/* REST
 * surface, authenticated as the supplied tenant. Cheap to call per
 * request; openai-node pools HTTP connections internally.
 *
 * Usage:
 *   const ai = makeRaindbAiClient(ctx.creds);
 *   const completion = await ai.chat.completions.create({
 *     model: 'fdn/sonnet',
 *     messages: [{ role: 'user', content: 'hi' }],
 *   });
 *
 * @throws when creds.apiKey or creds.endpoint is missing.
 */
export function makeRaindbAiClient(creds: GraphQLOptions): OpenAI {
  if (!creds.apiKey) {
    throw new Error('makeRaindbAiClient: creds.apiKey required');
  }
  if (!creds.endpoint) {
    throw new Error('makeRaindbAiClient: creds.endpoint required');
  }
  return new OpenAI({
    apiKey: creds.apiKey,
    baseURL: deriveOpenAIBaseURL(creds.endpoint),
  });
}

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
 */
export async function resolveDefaultModel(
  creds: GraphQLOptions,
  capability: string,
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
): Promise<string> {
  const m = await resolveDefaultModel(creds, 'chat');
  if (!m) {
    throw new Error(
      'resolveDefaultChatModel: raindb registry has no model with chat capability '
      + '(check platform_llm_model + platform_config_llm seeds)',
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
