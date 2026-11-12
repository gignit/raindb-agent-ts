// system.ts -- shared system-prompt builder.
//
// This is a thin scaffolding helper. Hosts compose their own
// product-specific system prompt and pass it through `runAgent`
// as `systemPrompt`. The package contributes the small "You are
// the agent for a RainDB-backed product" preamble shared across
// host applications and any future consumer.
//
// More elaborate prompt assembly (templating, mustache rendering,
// per-folder context blocks) lives in the host. Keep this minimal.

export interface SystemPromptBase {
  /**
   * Display name of the host product. Surfaced to the model so it
   * knows which surface it's running in.
   */
  productName: string;
  /**
   * One-paragraph mission statement describing the product. Tells
   * the model what it's helping the user do at the highest level.
   */
  productMission: string;
  /**
   * Caller's role string (host-defined). Threaded into the prompt
   * so the model can reason about what it's allowed to do.
   */
  callerRole: string;
}

export interface SystemPromptOptions extends SystemPromptBase {
  /**
   * Optional host-specific addendum appended after the shared
   * preamble. Typical content: project context, current folder,
   * recent activity, persona / coworker instructions.
   */
  hostAddendum?: string;
}

/**
 * Compose a system prompt. The returned string starts with a
 * shared preamble describing the agent's RainDB-backed nature,
 * then appends the host's product context. Tool descriptions
 * arrive separately via the `tools` array on `runAgent`; they
 * are NOT included in the system prompt.
 */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const lines: string[] = [];

  lines.push(`You are the AI assistant for ${opts.productName}.`);
  lines.push('');
  lines.push(opts.productMission.trim());
  lines.push('');
  lines.push(`The current operator's role is: ${opts.callerRole}.`);
  lines.push('');
  lines.push(
    'You have access to tools that read and (where authorized) write '
    + 'data in the operator\'s tenant. Tool names follow a '
    + '<domain>_<verb> convention (e.g. pack_list, droplet_create). '
    + 'When the user asks how to do something in RainDB or wants to '
    + 'see an established pattern, prefer pack_list and pack_info '
    + 'over guessing.',
  );

  if (opts.hostAddendum && opts.hostAddendum.trim()) {
    lines.push('');
    lines.push(opts.hostAddendum.trim());
  }

  return lines.join('\n');
}
