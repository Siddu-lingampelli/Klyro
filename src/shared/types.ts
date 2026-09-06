/** Base types shared across CLI, core, providers. */

export type Role = 'user' | 'assistant' | 'tool' | 'system';

export interface ContentBlock {
  kind: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  imageUrl?: string;
  id?: string;
  name?: string;
  input?: unknown;
  toolCallId?: string;
  output?: unknown;
  isError?: boolean;
}

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 7 | 8 | 130;

export const EXIT_TABLE: Record<string, number> = {
  success: 0,
  error: 1,
  usage: 2,
  config: 3,
  provider: 4,
  limit: 7,
  verify: 8,
  aborted: 130,
};
