/**
 * Message types shared between provider adapters and the runtime loop.
 *
 * Modeled after OpenAI/Anthropic chat-message shapes but kept simple:
 * a Message has a role and an array of ContentBlocks. ContentBlocks
 * cover text, tool_use (model asks to call a tool), and tool_result
 * (the harness feeds back the tool's observation).
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextBlock {
  kind: 'text';
  text: string;
}

export interface ToolUseBlock {
  kind: 'tool_use';
  /** Provider-assigned id; used to match a tool_result. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  kind: 'tool_result';
  /** Matches the ToolUseBlock.id. */
  toolCallId: string;
  /** Tool name (for routing on resume and debugging). */
  name: string;
  output: unknown;
  /** True if the tool itself failed (vs returning a normal value). */
  isError?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export function text(s: string): TextBlock {
  return { kind: 'text', text: s };
}

export function toolUse(id: string, name: string, input: Record<string, unknown>): ToolUseBlock {
  return { kind: 'tool_use', id, name, input };
}

export function toolResult(toolCallId: string, name: string, output: unknown, isError = false): ToolResultBlock {
  return { kind: 'tool_result', toolCallId, name, output, isError };
}

/** Convenience: extract every ToolUseBlock from an assistant message. */
export function toolUses(m: Message): ToolUseBlock[] {
  return m.content.filter((b): b is ToolUseBlock => b.kind === 'tool_use');
}
