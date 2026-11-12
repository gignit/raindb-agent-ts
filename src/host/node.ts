// host/node.ts -- the Node AgentHost. Wraps global fetch +
// openai-node so this is what existing Node consumers (host
// applications) bind to without changing their auth surface.
//
// The Node host is fully self-contained: no other host
// implementation should import from here. The bolt host implements
// the same AgentHost interface against the RainDB Lightning bolt
// sandbox primitives.

import OpenAI from 'openai';

import type { GraphQLOptions } from '../registry/types.js';
import type {
  AgentHost,
  ChatCompletionRequest,
  ChatCompletionResponse,
  HostFetchInit,
  HostResponse,
} from './types.js';

/**
 * Construct a Node AgentHost bound to a tenant's credentials.
 *
 * Cheap to call per-request; openai-node pools HTTP connections
 * internally and the wrapper around `globalThis.fetch` is a thin
 * pass-through.
 *
 * The endpoint in `creds` is the GraphQL endpoint
 * (e.g. http://localhost:8080/graphql). The openai baseURL is
 * derived by stripping `/graphql` and appending `/v1` -- the RainDB API
 * hosts both surfaces on the same origin.
 */
export function makeNodeHost(creds: GraphQLOptions): AgentHost {
  if (!creds.apiKey) {
    throw new Error('makeNodeHost: creds.apiKey required');
  }
  if (!creds.endpoint) {
    throw new Error('makeNodeHost: creds.endpoint required');
  }

  const baseURL = deriveOpenAIBaseURL(creds.endpoint);
  const ai = new OpenAI({
    apiKey: creds.apiKey,
    baseURL,
  });

  return {
    async fetch(url: string, init?: HostFetchInit): Promise<HostResponse> {
      const resp = await globalThis.fetch(url, {
        method: init?.method ?? 'GET',
        headers: init?.headers,
        body: init?.body,
      });
      return wrapResponse(resp);
    },

    async chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      // openai-node accepts the wire shape directly; we just need
      // to cast through `any` because our internal type isn't a
      // structural subset (we declared `[extra: string]: unknown`
      // for provider-specific knobs but openai-node's types are
      // closed). Passing the runtime object is safe; openai-node
      // serializes via JSON which round-trips through both shapes.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp = await ai.chat.completions.create(req as any);
      // openai-node returns a typed openai-spec response that
      // structurally matches our ChatCompletionResponse 1:1.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return resp as any as ChatCompletionResponse;
    },

    log: {
      info(msg, fields) {
        // eslint-disable-next-line no-console
        console.info(msg, fields ?? {});
      },
      warn(msg, fields) {
        // eslint-disable-next-line no-console
        console.warn(msg, fields ?? {});
      },
      error(msg, fields) {
        // eslint-disable-next-line no-console
        console.error(msg, fields ?? {});
      },
    },
  };
}

/**
 * The RainDB API hosts both the GraphQL surface (`/graphql`) and the
 * openai-spec REST surface (`/v1/*`) on the same origin. Strip the
 * trailing `/graphql` and append `/v1`.
 */
function deriveOpenAIBaseURL(graphqlEndpoint: string): string {
  return graphqlEndpoint.replace(/\/graphql\/?$/, '') + '/v1';
}

/**
 * Adapt a standard `Response` to the host-agnostic `HostResponse`
 * shape. The standard `Response` already has `.text()` and `.json()`
 * as methods so the adaptation is a structural pass-through plus a
 * normalized `headers` projection.
 */
function wrapResponse(resp: Response): HostResponse {
  const headers: Record<string, string | string[]> = {};
  resp.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    status: resp.status,
    ok: resp.ok,
    headers,
    text: () => resp.text(),
    json: () => resp.json(),
  };
}
