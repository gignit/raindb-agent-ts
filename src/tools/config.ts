// config.ts -- agent tools for tenant service-config inspection.
//
// Only config_get is exposed on the tenant surface. config_set is
// admin-scoped and would port under an admin catalog if one ships;
// config_list (a list-of-overlays) is not surfaced yet.

import { executeGraphQL } from '../client/graphql.js';
import { stringArg } from '../registry/build.js';
import type { RegisteredTool } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Wire shapes.
// ---------------------------------------------------------------------------

export interface RemoteServiceConfig {
  service: string;
  s3Path: string;
  config: Record<string, unknown>;
  etag?: string;
  exists: boolean;
}

interface ServiceConfigResponse {
  serviceConfig: RemoteServiceConfig | null;
}

const SERVICE_CONFIG_QUERY = `
  query ServiceConfig($service: String!) {
    serviceConfig(service: $service) {
      service
      s3Path
      config
      etag
      exists
    }
  }
`;

// ---------------------------------------------------------------------------
// config_get
// ---------------------------------------------------------------------------

export const config_get: RegisteredTool = {
  name: 'config_get',
  description:
    'Read the effective service config for one service (cyclone, api, '
    + 'periscope, duckdb, ...) merged across platform defaults + overlay. '
    + 'Equivalent CLI: raindb-cli config get',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      service: { type: 'string' },
    },
    required: ['service'],
  },
  async execute(ctx, args) {
    const service = stringArg(args, 'service');
    if (!service) {
      return { error: 'service required' };
    }
    const data = await executeGraphQL<ServiceConfigResponse>(
      SERVICE_CONFIG_QUERY,
      { service },
      ctx.creds,
      ctx.host,
    );
    if (!data.serviceConfig) {
      return { error: `serviceConfig: nil response for ${service}` };
    }
    return data.serviceConfig;
  },
};

export const configTools: RegisteredTool[] = [config_get];
