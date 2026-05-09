// config.ts -- agent tools for tenant service-config inspection.
//
// Mirrors raindb-phoenix-oc/internal/ai/tools_config.go::tenantConfigTools.
//
// Important: the Go reference exposes ONLY config_get on the tenant
// surface. The M2 checklist's draft included config_list + config_set
// from a stale audit -- they don't exist on the Go tenant tool table.
// (config_set is admin-scoped and ports under the admin catalog if
// we ever ship one; config_list would be a list-of-overlays which
// the Go side hasn't surfaced yet.)
//
// If/when the Go side adds them, mirror here. Don't invent surfaces
// the Go reference doesn't have.

import { executeGraphQL } from '../client/graphql.js';
import { stringArg } from '../registry/build.js';
import type { RegisteredTool } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Wire shapes (mirror internal/ops/service_config_remote.go::RemoteServiceConfig)
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
// config_get -- Go ref: tools_config.go::tenantConfigTools (lines 13-41)
//   + ops/service_config_remote.go::RemoteGetServiceConfig (lines 75-96)
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
    );
    if (!data.serviceConfig) {
      return { error: `serviceConfig: nil response for ${service}` };
    }
    return data.serviceConfig;
  },
};

export const configTools: RegisteredTool[] = [config_get];
