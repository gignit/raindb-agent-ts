// host/index.ts -- barrel for the AgentHost surface.
//
// Two known hosts:
//   - makeNodeHost(creds) for Node consumers (host applications).
//     Wraps globalThis.fetch + openai-node.
//   - The Lightning bolt host, which wraps the bolt sandbox's
//     ctx.fetch + ctx.secrets + ctx.log. Does not ship from this
//     package.

export type {
  AgentHost,
  HostFetchInit,
  HostResponse,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChoice,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionResponseMessage,
  ChatCompletionTool,
  ChatCompletionToolChoice,
  ChatContentPart,
} from './types.js';

export { makeNodeHost } from './node.js';
