// origin.ts -- derive the RainDB API origin from the GraphQL endpoint.
//
// The RainDB API serves GraphQL (`/graphql`), the openai-spec REST
// surface (`/v1/*`) and the marketplace REST surface
// (`/api/marketplace/*`) from one origin. `creds.endpoint` is the
// GraphQL URL; every other surface is addressed relative to its origin.

/**
 * Return the API origin for a GraphQL endpoint: the endpoint with a
 * trailing `/graphql` (and any trailing slash) removed. Throws when the
 * endpoint does not end in `/graphql`, because then the origin cannot
 * be derived deterministically.
 */
export function apiOriginFromEndpoint(graphqlEndpoint: string): string {
  const trimmed = graphqlEndpoint.trim().replace(/\/+$/, '');
  if (!/\/graphql$/.test(trimmed)) {
    throw new Error(
      `cannot derive the RainDB API origin from endpoint "${graphqlEndpoint}": `
      + 'expected a GraphQL URL ending in /graphql',
    );
  }
  return trimmed.replace(/\/graphql$/, '');
}
