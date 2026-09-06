#!/usr/bin/env node
/**
 * Klyro — autonomous coding harness CLI.
 *
 *   klyro                 start the TUI REPL
 *   klyro run "<prompt>"  one-shot autonomous task, streams to stdout
 *   klyro chat "<prompt>" legacy one-shot streamed chat (kept for compat)
 *   klyro chat            legacy interactive REPL (kept for compat)
 *   klyro eval <file>     run scripted scenarios (JSONL)
 *
 * Provider: OpenAI-compatible /v1/chat/completions endpoint.
 * Configure via env: KLYRO_BASE_URL, KLYRO_API_KEY, KLYRO_MODEL.
 */

import { Command } from 'commander';
import { chat } from './chat.js';
import { repl } from './repl.js';
import { runOnce } from './cli/run.js';
import { runEval } from './cli/eval.js';

const VERSION = '0.1.0';

function parsePositiveInt(name: string, v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid ${name}: ${v}`);
  return n;
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('klyro')
    .description('Klyro — autonomous coding harness')
    .version(VERSION, '-V, --version', 'Print the version number')
    .helpOption('-h, --help', 'Print this help message')
    .showHelpAfterError();

  // Default action: TUI REPL. For now this falls back to the legacy REPL
  // until the Ink-based TUI lands. The wiring point is cli/repl.ts.
  program
    .action(async () => {
      await repl('You are a helpful assistant.');
    });

  program
    .command('run <prompt>')
    .description('Run a one-shot autonomous task. Streams text to stdout; tool calls to stderr.')
    .option('-m, --model <id>', 'Model id (default: env KLYRO_MODEL)')
    .option('--max-steps <n>', 'Max agent steps (default 30)', (v) => parsePositiveInt('--max-steps', v))
    .option('--max-tokens <n>', 'Max output tokens per step', (v) => parsePositiveInt('--max-tokens', v))
    .option('--temperature <n>', 'Sampling temperature', (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error(`invalid --temperature: ${v}`);
      return n;
    })
    .option('--timeout <ms>', 'Request timeout in ms (default: env KLYRO_TIMEOUT_MS or 60000)', (v) => parsePositiveInt('--timeout', v))
    .option('--base-url <url>', 'Override KLYRO_BASE_URL')
    .option('--api-key <key>', 'Override KLYRO_API_KEY')
    .option('--output <mode>', 'Output mode: human (default), json (one JSON per line), silent')
    .option('--provider <name>', 'Provider: openai (default) or anthropic')
    .option('--dry-run', 'Print the prompt assembly (system, tools, task) and exit without calling the model')
    .option('--resume <file>', 'Resume from a saved transcript JSON file (must have a "transcript" field)')
    .action(async (prompt: string, opts: {
      model?: string; maxSteps?: number; maxTokens?: number; temperature?: number;
      timeout?: number; baseUrl?: string; apiKey?: string;
      output?: string; dryRun?: boolean; provider?: string; resume?: string;
    }) => {
      const model = opts.model ?? process.env.KLYRO_MODEL;
      if (!model) {
        process.stderr.write('klyro: KLYRO_MODEL is not set (or pass --model)\n');
        process.exit(2);
      }
      const output = (opts.output ?? 'human') as 'human' | 'json' | 'silent';
      if (output !== 'human' && output !== 'json' && output !== 'silent') {
        process.stderr.write(`klyro: invalid --output: ${output} (expected human|json|silent)\n`);
        process.exit(2);
      }
      const provider = (opts.provider ?? 'openai') as 'openai' | 'anthropic';
      if (provider !== 'openai' && provider !== 'anthropic') {
        process.stderr.write(`klyro: invalid --provider: ${provider} (expected openai|anthropic)\n`);
        process.exit(2);
      }
      try {
        const code = await runOnce({
          task: prompt,
          cwd: process.cwd(),
          model,
          maxSteps: opts.maxSteps,
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          timeoutMs: opts.timeout,
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          output,
          provider,
          dryRun: !!opts.dryRun,
          resumePath: opts.resume,
        });
        process.exit(code);
      } catch (err) {
        process.stderr.write(`klyro: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(2);
      }
    });

  program
    .command('chat [prompt]')
    .description('Legacy streamed chat. Without a prompt, start an interactive REPL.')
    .option('-s, --system <text>', 'System message', 'You are a helpful assistant.')
    .option('-m, --model <id>', 'Override the model (default: env KLYRO_MODEL)')
    .option('-t, --timeout <ms>', 'Request timeout in ms (default: env KLYRO_TIMEOUT_MS or 60000)', (v) => parsePositiveInt('-t/--timeout', v))
    .action(async (prompt: string | undefined, opts: { system: string; model?: string; timeout?: number }) => {
      if (!prompt) {
        await repl(opts.system);
      } else {
        await chat(prompt, opts.system, opts.model, { timeoutMs: opts.timeout });
      }
    });

  program
    .command('eval <input>')
    .description('Run scripted scenarios from a JSONL file against the agent runtime. Exits 0 if all pass, 1 otherwise.')
    .option('--output <mode>', 'Output mode: human (default), json (one JSON per line)')
    .action(async (input: string, opts: { output?: string }) => {
      const output = (opts.output ?? 'human') as 'human' | 'json' | 'silent';
      const code = await runEval({ inputPath: input, output });
      process.exit(code);
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  // Last-resort: anything that escaped the command handlers lands here.
  // eslint-disable-next-line no-console
  console.error(`klyro: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
