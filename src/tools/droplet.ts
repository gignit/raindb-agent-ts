// droplet.ts -- agent tools for droplet primitives.
//
// Mirrors raindb-phoenix-oc/internal/ai/tools_droplet.go. Tool
// names + parameters match exactly so the Go and TS surfaces are
// substitutable from the model's perspective.
//
// Milestone 1 ships only `droplet_create` as the pilot mutating
// tool -- it proves the `modifiesResource: true` flag flows
// through the agent loop's confirm gate. The remaining droplet
// tools (read_current, read_by_id, read_latest, list, keys,
// update, push_public, upload, download, bulk_create, bulk_update)
// land in Milestone 2.

import { executeGraphQL } from '../client/graphql.js';
import {
  boolArg,
  objectArg,
  stringArg,
} from '../registry/build.js';
import type { RegisteredTool } from '../registry/types.js';

// ---------------------------------------------------------------------------
// Wire shapes (mirror raindb-phoenix-oc/internal/ops/droplet.go)
// ---------------------------------------------------------------------------

/**
 * The result of a successful droplet write. Mirrors the GraphQL
 * `WriteResult` type and the Go `ops.WriteResult` struct.
 */
export interface WriteResult {
  dropletId: string;
  pathsWritten: string[];
  floatPaths: string[];
  publicUrls: string[];
  vectorRefs: string[];
  warnings: string[];
  scopeValue?: string | null;
  pointerETag?: string | null;
  durationMs: number;
}

interface WriteDropletResponse {
  writeDroplet: WriteResult;
}

const WRITE_DROPLET_MUTATION = `
  mutation WriteDroplet($input: WriteDropletInput!) {
    writeDroplet(input: $input) {
      dropletId
      pathsWritten
      floatPaths
      publicUrls
      vectorRefs
      warnings
      scopeValue
      pointerETag
      durationMs
    }
  }
`;

// ---------------------------------------------------------------------------
// droplet_create -- Go reference:
// tools_droplet.go::tenantDropletTools, the entry at lines 142-167.
// GraphQL operation: ops/droplet.go::WriteDroplet (lines 209-248).
// Wire input shape: pkg/api/graph/model/models_gen.go::WriteDropletInput
// (lines 1682-1690).
// ---------------------------------------------------------------------------

export const droplet_create: RegisteredTool = {
  name: 'droplet_create',
  description:
    'Create a new droplet in a formation. Optionally dispatches flow events. '
    + 'Equivalent CLI: raindb-cli droplet create --formation <id> --payload <json>.',
  minRole: 'write',
  modifiesResource: true,
  parameters: {
    type: 'object',
    properties: {
      formation: { type: 'string' },
      payload: {
        type: 'object',
        description: "Droplet payload; shape follows the formation's schema.",
      },
      triggerFlows: {
        type: 'boolean',
        description: 'Dispatch flow events (default true).',
      },
    },
    required: ['formation', 'payload'],
  },
  async execute(ctx, args) {
    const formation = stringArg(args, 'formation');
    const payload = objectArg(args, 'payload');
    if (!formation) {
      return { error: 'formation is required' };
    }
    if (!payload) {
      return { error: 'payload (object) is required' };
    }
    const triggerFlows = boolArg(args, 'triggerFlows', true);

    // Author resolution: prefer the host's userId when supplied;
    // fall back to a stable "agent" sentinel so audit logs at least
    // identify the writer as the agent surface vs. a human.
    const author = ctx.userId && ctx.userId.trim() !== ''
      ? ctx.userId
      : 'agent';

    const data = await executeGraphQL<WriteDropletResponse>(
      WRITE_DROPLET_MUTATION,
      {
        input: {
          formationId: formation,
          payload,
          author,
          triggerFlows,
        },
      },
      ctx.creds,
    );
    return data.writeDroplet;
  },
};

/** Per-domain catalog -- expands in Milestone 2. */
export const dropletTools: RegisteredTool[] = [droplet_create];
