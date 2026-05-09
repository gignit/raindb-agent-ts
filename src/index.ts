/**
 * @raindb/agent -- shared TypeScript agent runtime + tool catalog
 * for the RainDB ecosystem.
 *
 * This file is the public API surface of the package. Consumers
 * (fdn-app, raindb-app) bind to these exports; changing them is a
 * breaking change. Everything else under src/ is internal.
 *
 * The package is empty in v0.1.0-pre. Milestone 1 will land:
 *   - runAgent (extracted from fdn-app/server/src/services/agentLoop.ts)
 *   - RegisteredTool, ToolContext, ToolRole, GraphQLOptions
 *   - buildToolDefs, augmentDescription
 *   - buildSystemPrompt
 *   - pack_list (read-only reference tool)
 *   - droplet_create (mutating reference tool)
 *
 * See README.md for the full plan + the agent's operating manual.
 */

export const VERSION = '0.1.0-pre';
