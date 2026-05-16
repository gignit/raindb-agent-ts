// ensureHost.ts -- ToolContext host normalizer.
//
// Existing code paths in fdn-app + raindb-app construct ToolContext
// from {creds, role, userId, product, marketplaceBaseUrl} without a
// `host` field -- the host abstraction was added in the
// goja-host-adapter refactor and predates those call sites.
//
// `ensureHost(ctx)` returns a normalized ctx with `host` populated
// via `makeNodeHost(ctx.creds)` when absent. This is the migration
// shim for Node consumers; it preserves the existing surface while
// allowing new ToolContext constructions to pass a host directly
// (the bolt host, a mock host in tests, etc.).
//
// Internal call sites in this package (runAgent's chat completion,
// tools' GraphQL calls, marketplace fetches) call `ensureHost` once
// at the entry point and then read `ctx.host.*` thereafter. They
// never re-check or re-fill.

import { makeNodeHost } from '../host/node.js';
import type { ToolContext } from './types.js';

/**
 * Normalize a ToolContext so `ctx.host` is populated. When the
 * incoming `ctx.host` is already set (the bolt host, a mock test
 * host, a host bound to a different LLM provider), returns the ctx
 * unchanged. When absent, returns a new ctx with
 * `makeNodeHost(ctx.creds)` filled in.
 *
 * Cheap when host is already set: returns the input by reference.
 * The Node-host construction path requires creds.apiKey +
 * creds.endpoint -- absence throws the same error makeNodeHost does.
 *
 * Idempotent: passing an already-normalized ctx returns it unchanged.
 */
export function ensureHost(ctx: ToolContext): ToolContext {
  if (ctx.host) {
    return ctx;
  }
  return {
    ...ctx,
    host: makeNodeHost(ctx.creds),
  };
}
