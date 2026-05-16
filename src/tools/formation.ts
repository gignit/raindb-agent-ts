// formation.ts -- agent tools for formation introspection +
// publishing.
//
// Mirrors raindb-phoenix-oc/internal/ai/tools_formation.go::tenantFormationTools.
// Three tools: formation_list (read), formation_describe (read),
// formation_publish (admin, modifiesResource).

import { executeGraphQL } from '../client/graphql.js';
import {
  intArg,
  objectArg,
  stringArg,
} from '../registry/build.js';
import type { RegisteredTool } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Wire shapes (mirror internal/ops/formation.go)
// ---------------------------------------------------------------------------

export interface FormationInfo {
  formationId: string;
  schemaVersion: number;
  scopeKey: string;
  visibility: string;
}

export interface FormationDetail {
  formationId: string;
  schemaVersion: number;
  scopeKey: string;
  visibility: string;
  config: Record<string, unknown>;
  schema?: Record<string, unknown>;
}

export interface PublishFormationResult {
  formationId: string;
  schemaVersion: number;
  pathsWritten: string[];
}

interface ListFormationsResponse {
  listFormations: FormationInfo[];
}

interface DescribeFormationResponse {
  describeFormation: FormationDetail | null;
}

interface PublishFormationResponse {
  publishFormation: PublishFormationResult;
}

// Queries mirror internal/ops/queries.go verbatim. Selection sets
// stay in lockstep with the Go side.

const LIST_FORMATIONS_QUERY = `
  query {
    listFormations {
      formationId
      schemaVersion
      scopeKey
      visibility
    }
  }
`;

const DESCRIBE_FORMATION_QUERY = `
  query DescribeFormation($formationId: String!) {
    describeFormation(formationId: $formationId) {
      formationId
      schemaVersion
      scopeKey
      visibility
      config
      schema
    }
  }
`;

const PUBLISH_FORMATION_MUTATION = `
  mutation PublishFormation($formationId: String!, $config: JSON!, $schema: JSON!, $schemaVersion: Int!) {
    publishFormation(formationId: $formationId, config: $config, schema: $schema, schemaVersion: $schemaVersion) {
      formationId
      schemaVersion
      pathsWritten
    }
  }
`;

// ---------------------------------------------------------------------------
// formation_list -- Go ref: tools_formation.go (lines 17-28)
//   + ops/formation.go::ListFormations (lines 36-44)
// ---------------------------------------------------------------------------

export const formation_list: RegisteredTool = {
  name: 'formation_list',
  description:
    'List formations accessible to the current tenant. '
    + 'Equivalent CLI: raindb-cli formation list',
  minRole: 'read',
  parameters: { type: 'object' },
  async execute(ctx) {
    const data = await executeGraphQL<ListFormationsResponse>(
      LIST_FORMATIONS_QUERY,
      {},
      ctx.creds,
      ctx.host,
    );
    return data.listFormations;
  },
};

// ---------------------------------------------------------------------------
// formation_describe -- Go ref: tools_formation.go (lines 29-50)
//   + ops/formation.go::DescribeFormation (lines 47-64)
// ---------------------------------------------------------------------------

export const formation_describe: RegisteredTool = {
  name: 'formation_describe',
  description:
    'Show the full formation definition (schema, indexes, tier config, '
    + 'catalog schema, etc.). Call before catalog_insert or droplet_create '
    + 'to learn the shape. Equivalent CLI: raindb-cli formation describe',
  minRole: 'read',
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
    },
    required: ['formation'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    if (!formation) {
      return { error: 'formation required' };
    }
    const data = await executeGraphQL<DescribeFormationResponse>(
      DESCRIBE_FORMATION_QUERY,
      { formationId: formation },
      ctx.creds,
      ctx.host,
    );
    if (!data.describeFormation) {
      return { error: `formation not found: ${formation}` };
    }
    return data.describeFormation;
  },
};

// ---------------------------------------------------------------------------
// formation_publish -- Go ref: tools_formation.go (lines 51-79)
//   + ops/formation.go::PublishFormation (lines 68-93)
// ---------------------------------------------------------------------------

export const formation_publish: RegisteredTool = {
  name: 'formation_publish',
  description:
    'Publish a new formation config + optional JSON schema. Bumps '
    + 'schemaVersion; old versions remain readable. Equivalent CLI: '
    + 'raindb-cli formation publish',
  minRole: 'admin',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string', description: 'Formation ID' },
      config: { type: 'object', description: 'Formation config object' },
      schema: { type: 'object', description: 'Optional JSON schema object' },
      schemaVersion: {
        type: 'integer',
        description: 'Schema version (must be positive)',
      },
    },
    required: ['formation', 'config', 'schemaVersion'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const config = objectArg(args, 'config');
    const version = intArg(args, 'schemaVersion', 0);
    if (!formation || !config || version <= 0) {
      return {
        error: 'formation, config (object), schemaVersion (>0) required',
      };
    }
    const schema = objectArg(args, 'schema') ?? {};
    const data = await executeGraphQL<PublishFormationResponse>(
      PUBLISH_FORMATION_MUTATION,
      {
        formationId: formation,
        config,
        schema,
        schemaVersion: version,
      },
      ctx.creds,
      ctx.host,
    );
    return data.publishFormation;
  },
};

export const formationTools: RegisteredTool[] = [
  formation_list,
  formation_describe,
  formation_publish,
];
