// graphql.ts -- minimal GraphQL HTTP client for raindb-api.
//
// Extracted from fdn-app/server/src/raindb.ts::graphqlRequest.
// Single responsibility: POST a query + variables to the configured
// raindb-api endpoint, send the tenant API key header, parse the
// response, surface errors as RaindbError. Nothing else.
//
// The package never reads process.env directly. Every call MUST
// pass GraphQLOptions with at least an apiKey + endpoint; hosts
// resolve those from their own auth surface (fdn-app from
// resolveProjectCreds, raindb-app from session-derived creds, etc.).

import type { GraphQLOptions } from '../registry/types.js';

interface GraphQLError {
  message: string;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

/**
 * Error surface for every GraphQL failure path. Wraps:
 *   - Non-JSON HTTP responses (network / 5xx with HTML body)
 *   - GraphQL-level errors[] arrays
 *   - Empty data fields
 *
 * Hosts can introspect `graphqlErrors`, `extensions`, and `status`
 * to decide on retry or surface specific messages to users.
 */
export class RaindbError extends Error {
  readonly status?: number;
  readonly graphqlErrors?: GraphQLError[];
  readonly extensions?: Record<string, unknown>;

  constructor(
    message: string,
    init?: {
      status?: number;
      graphqlErrors?: GraphQLError[];
      extensions?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = 'RaindbError';
    this.status = init?.status;
    this.graphqlErrors = init?.graphqlErrors;
    this.extensions = init?.extensions;
  }
}

/**
 * Execute a GraphQL operation against raindb-api.
 *
 * The `creds` argument carries the tenant API key + endpoint
 * resolved by the host. Both fields are required at call time;
 * the function does not fall back to env vars (per the package's
 * leaf-layer rule -- see README §Layer rules).
 *
 * @param query     The GraphQL query/mutation string.
 * @param variables Map passed as the operation's `variables` field.
 * @param creds     Tenant credentials resolved by the host.
 * @returns         The `data` field of the response, typed as T.
 * @throws RaindbError on any failure path.
 */
export async function executeGraphQL<T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown>,
  creds: GraphQLOptions,
): Promise<T> {
  if (!creds.apiKey) {
    throw new RaindbError('executeGraphQL: creds.apiKey required');
  }
  if (!creds.endpoint) {
    throw new RaindbError('executeGraphQL: creds.endpoint required');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': creds.apiKey,
  };

  const response = await fetch(creds.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  let body: GraphQLResponse<T>;
  try {
    body = (await response.json()) as GraphQLResponse<T>;
  } catch {
    throw new RaindbError(
      `raindb returned non-JSON (status ${response.status})`,
      { status: response.status },
    );
  }

  if (body.errors && body.errors.length > 0) {
    const first = body.errors[0]!;
    throw new RaindbError(first.message, {
      status: response.status,
      graphqlErrors: body.errors,
      extensions: first.extensions,
    });
  }

  if (!body.data) {
    throw new RaindbError('GraphQL response had no data', {
      status: response.status,
    });
  }

  return body.data;
}
