import { z } from 'zod';
import { defineTool } from '../types.js';
import { safe } from '../normalize.js';

const InputSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
});

export const askUserTool = defineTool({
  name: 'ask_user',
  description: 'Ask the user a question (multiple choice or free text). Headless fails fast unless --auto-answer.',
  inputSchema: InputSchema,
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input, ctx) => {
    return safe(async () => {
      if (ctx.nonInteractive) {
        // Check for auto-answer
        const auto = process.env.KLYRO_AUTO_ANSWER;
        if (auto) return { answer: auto } as const;
        throw Object.assign(new Error(`ask_user requires interaction: ${input.question}`), { code: 'HEADLESS' });
      }
      // In TUI, this will be handled via ApprovalModal with ask_user kind
      // For now, return as requires approval
      return { question: input.question, options: input.options } as const;
    });
  },
});
