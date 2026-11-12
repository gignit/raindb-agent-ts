// build.ts -- registry helpers: filter tools by role, project to
// openai-spec ChatTool wire shape, plus the small arg-coercion
// helpers every tool body uses.
//
// Provides buildToolDefs and the arg-helper conventions (stringArg,
// intArg, boolArg, stringSliceArg).

import type OpenAI from 'openai';

import type {
  RegisteredTool,
  ToolArgs,
  ToolRole,
} from './types.js';

type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

/**
 * Numeric ranking so we can do `caller >= tool.minRole` checks
 * without a switch. read=1, write=2, admin=3. Hosts using a
 * custom role string can replace this with their own comparator
 * by calling `buildToolDefsWithFilter` directly.
 */
const ROLE_RANK: Record<ToolRole, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

/**
 * Default role comparator: caller's role must rank >= the tool's
 * `minRole`. Tools with unknown roles fall through to admin
 * (most-restrictive default).
 */
export function defaultRoleAllows(
  callerRole: ToolRole,
  toolMinRole: ToolRole,
): boolean {
  const caller = ROLE_RANK[callerRole] ?? 0;
  const required = ROLE_RANK[toolMinRole] ?? Number.MAX_SAFE_INTEGER;
  return caller >= required;
}

/**
 * Project a `RegisteredTool` to the openai-spec ChatTool wire
 * shape. The agent loop forwards the result to
 * ai.chat.completions.create({ tools }).
 */
export function toChatTool(tool: RegisteredTool): ChatTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
    },
  };
}

/**
 * Filter a tool catalog by the caller's role and project to
 * ChatTool wire format for the model. The default comparator
 * uses the read/write/admin ladder; pass a custom comparator
 * when the host needs different semantics.
 */
export function buildToolDefs(
  tools: RegisteredTool[],
  callerRole: ToolRole,
  roleAllows: (
    callerRole: ToolRole,
    toolMinRole: ToolRole,
  ) => boolean = defaultRoleAllows,
): ChatTool[] {
  return tools
    .filter((t) => roleAllows(callerRole, t.minRole))
    .map(toChatTool);
}

/**
 * Resolve a tool by name from a catalog. Returns null when the
 * model emitted a name that isn't registered (the loop turns this
 * into a tool-error the model can recover from).
 */
export function findTool(
  tools: RegisteredTool[],
  name: string,
): RegisteredTool | null {
  return tools.find((t) => t.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Arg-coercion helpers. Tool bodies pull values defensively because
// the LLM's args object is typed as `Record<string, unknown>`.
// ---------------------------------------------------------------------------

/** Coerce args[key] to a non-empty trimmed string, or "" otherwise. */
export function stringArg(args: ToolArgs, key: string): string {
  const v = args[key];
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/**
 * Coerce args[key] to a finite integer or fall back to def.
 * Accepts numeric strings ("100") for LLMs that emit numbers as
 * strings; rejects NaN/Infinity.
 */
export function intArg(args: ToolArgs, key: string, def: number): number {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return def;
}

/**
 * Coerce args[key] to a bool or fall back to def. Accepts the
 * string "true" / "false" because some smaller models emit those
 * instead of JSON booleans.
 */
export function boolArg(args: ToolArgs, key: string, def: boolean): boolean {
  const v = args[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return def;
}

/** Coerce args[key] to a string[]. Filters out non-strings + empties. */
export function stringSliceArg(args: ToolArgs, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      const s = item.trim();
      if (s !== '') out.push(s);
    }
  }
  return out;
}

/** Coerce args[key] to a Record. Returns null when the value isn't an object. */
export function objectArg(
  args: ToolArgs,
  key: string,
): Record<string, unknown> | null {
  const v = args[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}
