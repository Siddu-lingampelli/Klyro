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

import { Command, InvalidArgumentError } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chat } from './chat.js';
import { repl } from './repl.js';
import { startRepl } from './cli/repl.js';
import { runOnce } from './cli/run.js';
import { runEval } from './cli/eval.js';
import { runConfig } from './cli/config.js';
import { runDoctor } from './cli/doctor.js';
import { runCompletion } from './cli/completion.js';
import { runUpdate } from './cli/update.js';
import { runLogin, runLogout } from './cli/auth.js';

// Read version from package.json so `klyro --version` always matches the
// published version. Walks up from this file (src/index.ts) to find the
// nearest package.json.
function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'package.json'),
    resolve(here, '../..', 'package.json'),
    resolve(here, '../../package.json'),
  ];
  for (const pkgPath of candidates) {
    try {
      const raw = readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as { version?: string };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Only ignore missing file; surface JSON parse errors
      if (e.code === 'ENOENT') continue;
      // Malformed JSON — warn but don't crash version output
      process.stderr.write(`klyro: warning: malformed ${pkgPath}: ${e.message}\n`);
      continue;
    }
  }
  // Fallback: try require-style resolution
  try {
    const pkgPath = resolve(process.cwd(), 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string; name?: string };
    if (pkg.name === 'klyro' && typeof pkg.version === 'string') return pkg.version;
  } catch {
    // ignore
  }
  return '0.0.0';
}

const VERSION = readVersion();

function parsePositiveInt(name: string, v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError(`invalid ${name}: ${v}`);
  }
  return n;
}

function parseTemperature(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 2) {
    throw new InvalidArgumentError(`invalid --temperature: ${v} (expected 0-2)`);
  }
  return n;
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('klyro')
    .description('Klyro — autonomous coding harness')
    .version(VERSION, '-V, --version', 'Print the version number')
    .helpOption('-h, --help', 'Print this help message')
    .showHelpAfterError()
    .showSuggestionAfterError(true);

  // Global flags — 1.2 + 2.5 headless
  program
    .option('--cwd <path>', 'Change working directory')
    .option('--config <path>', 'Override config file path (sets KLYRO_CONFIG)')
    .option('--debug', 'Enable debug logging')
    .option('--verbose', 'Verbose output')
    .option('--quiet', 'Suppress non-essential output')
    .option('--json', 'Force JSON output where supported')
    .option('--yes', 'Auto-approve prompts where possible')
    .option('--no-color', 'Disable colored output')
    .option('-p, --print <prompt>', 'Headless one-shot prompt (alias for run, --output json for machine)')
    .option('--output-format <fmt>', 'Headless output format: text|json|stream-json (default text)')
    .option('--no-stream', 'Disable streaming (buffer full response)')
    .option('--show-thinking', 'Show thinking blocks');

  // Handle global flags before any command runs
  program.hook('preAction', (thisCommand) => {
    const opts = thisCommand.optsWithGlobals<{ cwd?: string; config?: string; debug?: boolean; verbose?: boolean; quiet?: boolean; json?: boolean; yes?: boolean; color?: boolean }>();
    if (opts.cwd) {
      try {
        process.chdir(opts.cwd);
      } catch (err) {
        process.stderr.write(`klyro: --cwd: cannot chdir to ${opts.cwd}: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(2);
      }
    }
    if (opts.config) process.env.KLYRO_CONFIG = opts.config;
    if (opts.debug) process.env.KLYRO_LOG_LEVEL = 'debug';
    if (opts.verbose) process.env.KLYRO_LOG_LEVEL = 'debug';
    if (opts.quiet) process.env.KLYRO_QUIET = '1';
    if (opts.json) process.env.KLYRO_JSON = '1';
    if (opts.yes) process.env.KLYRO_YES = '1';
    if (opts.color === false || process.env.NO_COLOR === '1') {
      process.env.FORCE_COLOR = '0';
      process.env.NO_COLOR = '1';
    } else if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) {
      // Respect NO_COLOR/FORCE_COLOR if already set, otherwise honor terminal
      if (process.env.TERM === 'dumb' || process.env.CI === '1') {
        // leave as is
      }
    }
  });

  // Top-level TUI overrides — single definition; commander auto-creates --no-tui negation
  // Note: -m/--model and --max-steps are defined only on the `tui` subcommand to avoid
  // CommanderError "option already exists" (parent options are inherited by subcommands).
  program
    .option('--tui', 'Force Ink TUI even when stdin is not a TTY')
    .option('--chat', 'Alias for --no-tui (force legacy chat REPL)');

  // Explicit `klyro tui` command — always uses the Ink UI.
  program
    .command('tui')
    .description('Start the Ink TUI REPL (same as bare `klyro` on a TTY)')
    .option('-m, --model <id>', 'Model id (default: auto-detected)')
    .option('--max-steps <n>', 'Max agent steps (default 30)', (v) => parsePositiveInt('--max-steps', v))
    .action(async (opts: { model?: string; maxSteps?: number }) => {
      const code = await startRepl({ model: opts.model, maxSteps: opts.maxSteps, forceTty: true });
      process.exit(code);
    });

  program
    .command('completion <shell>')
    .description('Generate shell completion script (bash|zsh|fish|powershell)')
    .action(async (shell: string) => {
      const code = await runCompletion(shell);
      process.exit(code);
    });

  program
    .command('update')
    .description('Check for klyro updates (cached 24h, KLYRO_NO_UPDATE_CHECK=1 to disable)')
    .action(async () => {
      const code = await runUpdate();
      process.exit(code);
    });

  program
    .command('login')
    .description('Login and store API key (masked, 0600) — provider auto-select')
    .action(async () => {
      const code = await runLogin();
      process.exit(code);
    });

  program
    .command('logout [provider]')
    .description('Remove stored credentials')
    .action(async (provider?: string) => {
      const code = await runLogout(provider);
      process.exit(code);
    });

  // LEVEL 1 — config & doctor (graduation requires klyro config / klyro doctor)
  program
    .command('config [command] [key] [value]')
    .description('Manage klyro config file (~/.klyro/config.json). Commands: list, get, set, unset, path')
    .allowUnknownOption(false)
    .action(async (command?: string, key?: string, value?: string) => {
      const args: string[] = [];
      if (command) args.push(command);
      if (key) args.push(key);
      if (value !== undefined) args.push(value);
      // Also capture remaining raw args for `set a b c` style values
      // commander splits `set x y z` as command=set key=x value=y, but z is lost —
      // so re-parse from raw argv for set
      const raw = process.argv.slice(2);
      const idx = raw.indexOf('config');
      if (idx !== -1 && command === 'set' && key) {
        // everything after `config set <key>` is the value
        const after = raw.slice(idx + 3);
        const fullValue = after.join(' ');
        const code = await runConfig(['set', key, fullValue]);
        process.exit(code);
      }
      const code = await runConfig(args);
      process.exit(code);
    });

  program
    .command('doctor')
    .description('Run diagnostics (node, config, provider, sessions, git, tools)')
    .option('--json', 'Output JSON')
    .action(async (opts: { json?: boolean }) => {
      const code = await runDoctor({ json: !!opts.json });
      process.exit(code);
    });

  // Support `klyro "prompt"` positional headless (2.5)
  program.argument('[prompt]', 'Headless one-shot prompt (same as -p)');

  program
    .action(async (promptArg?: string) => {
      const opts = program.opts<{ tui?: boolean; chat?: boolean; print?: string; outputFormat?: string; json?: boolean; maxTokens?: number; stream?: boolean }>();
      // Headless via -p / --print or positional prompt
      const headlessPrompt = opts.print ?? promptArg;
      if (headlessPrompt) {
        // Handle stdin piping: if stdin has data, append
        let stdinText = '';
        if (!process.stdin.isTTY) {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
            stdinText = Buffer.concat(chunks).toString('utf-8').trim();
          } catch { /* ignore */ }
        }
        const fullPrompt = stdinText ? `${headlessPrompt}\n\n${stdinText}` : headlessPrompt;
        const outputFormat = opts.outputFormat ?? (opts.json ? 'json' : 'text');
        const output = outputFormat === 'json' ? 'json' : outputFormat === 'stream-json' ? 'json' : 'human';
        const code = await runOnce({
          task: fullPrompt,
          cwd: process.cwd(),
          model: process.env.KLYRO_MODEL ?? 'gpt-4o-mini',
          maxTokens: opts.maxTokens,
          output: output as 'human' | 'json' | 'silent',
          provider: (process.env.KLYRO_PROVIDER as 'openai' | 'anthropic' | undefined),
        });
        process.exit(code);
      }

      const forceTui = opts.tui === true;
      const forceLegacy = opts.chat === true || opts.tui === false;
      if (forceTui && forceLegacy) {
        process.stderr.write('klyro: --tui and --no-tui/--chat are mutually exclusive\n');
        process.exit(2);
      }
      if (forceTui) {
        const code = await startRepl({ forceTty: true });
        process.exit(code);
      }
      if (forceLegacy) {
        await repl('You are a helpful assistant.');
        return;
      }
      if (process.stdin.isTTY) {
        const code = await startRepl();
        process.exit(code);
      }
      // Non-TTY without explicit flag: explain UI requires TTY, but avoid infinite loop on empty pipe
      if (process.stdin.readableEnded || (process.stdin as unknown as { destroyed?: boolean }).destroyed) {
        process.stderr.write('klyro: no TTY and no input pipe — nothing to do. Try `klyro --help` or `klyro run \"<task>\"`\n');
        process.exit(2);
      }
      process.stderr.write('klyro: no TTY detected — starting legacy REPL (pipe mode)\n');
      process.stderr.write('  Tip: run `klyro tui` or `klyro --tui` to force the Ink UI, or `klyro --help` for options.\n');
      await repl('You are a helpful assistant.');
    });

  program
    .command('run <prompt>')
    .description('Run a one-shot autonomous task. Streams text to stdout; tool calls to stderr.')
    .option('-m, --model <id>', 'Model id (default: env KLYRO_MODEL)')
    .option('--max-steps <n>', 'Max agent steps (default 30)', (v) => parsePositiveInt('--max-steps', v))
    .option('--max-tokens <n>', 'Max output tokens per step', (v) => parsePositiveInt('--max-tokens', v))
    .option('--temperature <n>', 'Sampling temperature (0-2)', parseTemperature)
    .option('--timeout <ms>', 'Request timeout in ms (default: env KLYRO_TIMEOUT_MS or 60000)', (v) => parsePositiveInt('--timeout', v))
    .option('--base-url <url>', 'Override KLYRO_BASE_URL')
    .option('--api-key <key>', 'Override KLYRO_API_KEY')
    .option('--output <mode>', 'Output mode: human (default), json (one JSON per line), silent')
    .option('--provider <name>', 'Provider: openai (default) or anthropic')
    .option('--dry-run', 'Print the prompt assembly (system, tools, task) and exit without calling the model')
    .option('--resume <file>', 'Resume from a saved transcript JSON file (must have a "transcript" field)')
    .option('--resume-session <id>', 'Resume from a persisted session (Level 9) by id prefix')
    .option('--verify', 'Enable verification after edits (Level 8, default: enabled)')
    .option('--verify-command <cmd>', 'Custom verification command (default: auto-detected)')
    .option('--max-repairs <n>', 'Max autonomous repair attempts (default 3)', (v) => parsePositiveInt('--max-repairs', v))
    .option('--persist', 'Enable session persistence (Level 9, default: enabled)')
    .option('--require-verify', 'Fail with exit 8 if no verification passed after edits (6.5)')
    .action(async (prompt: string, opts: {
      model?: string; maxSteps?: number; maxTokens?: number; temperature?: number;
      timeout?: number; baseUrl?: string; apiKey?: string;
      output?: string; dryRun?: boolean; provider?: string; resume?: string;
      resumeSession?: string; verify?: boolean; verifyCommand?: string; maxRepairs?: number; persist?: boolean; requireVerify?: boolean;
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
      // Provider validation is handled inside runOnce (single source of truth)
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
          provider: opts.provider as 'openai' | 'anthropic' | undefined,
          dryRun: !!opts.dryRun,
          resumePath: opts.resume,
          sessionId: opts.resumeSession,
          verify: opts.verify,
          verifyCommand: opts.verifyCommand,
          maxRepairAttempts: opts.maxRepairs,
          persist: opts.persist,
          requireVerify: !!opts.requireVerify,
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
    .command('eval [input]')
    .description('Run eval harness: klyro eval --suite smoke | klyro eval <input.jsonl>')
    .option('--output <mode>', 'Output mode: human (default), json (one JSON per line)')
    .option('--suite <name>', 'Suite name (smoke, core, etc.) — loads from evals/fixtures')
    .option('--filter <str>', 'Filter fixtures by name substring')
    .option('--runs <n>', 'Runs per fixture (default 1)', (v) => parsePositiveInt('--runs', v))
    .option('--parallel <n>', 'Parallelism (default 1)', (v) => parsePositiveInt('--parallel', v))
    .option('--model <id>', 'Model for eval')
    .action(async (input: string | undefined, opts: { output?: string; suite?: string; filter?: string; runs?: number; parallel?: number; model?: string }) => {
      const output = (opts.output ?? 'human') as 'human' | 'json' | 'silent';
      if (opts.suite) {
        const code = await runEval({ inputPath: input ?? '-', output, suite: opts.suite, filter: opts.filter, runs: opts.runs, parallel: opts.parallel, model: opts.model });
        process.exit(code);
      }
      if (!input) {
        process.stderr.write('klyro eval: missing input (provide <input> or --suite)\n');
        process.exit(2);
      }
      const code = await runEval({ inputPath: input, output, suite: opts.suite, filter: opts.filter, runs: opts.runs, parallel: opts.parallel, model: opts.model });
      process.exit(code);
    });

  program
    .command('eval:compare <a> <b>')
    .description('Compare two eval results JSON files')
    .action(async (a: string, b: string) => {
      const { compareReports } = await import('./eval/harness.js');
      const fs = await import('node:fs/promises');
      const ra = JSON.parse(await fs.readFile(a, 'utf-8'));
      const rb = JSON.parse(await fs.readFile(b, 'utf-8'));
      const out = compareReports(ra, rb);
      process.stdout.write(out + '\n');
      process.exit(0);
    });

  // Level 9 — Session management
  const session = program.command('session').description('Session persistence (Level 9)');
  session
    .command('list')
    .description('List persisted sessions')
    .option('--status <s>', 'Filter by status: open|complete|verify_failed|aborted|max_steps')
    .option('--json', 'Output JSON')
    .action(async (opts: { status?: string; json?: boolean }) => {
      const { getDefaultSessionStore, formatSession } = await import('./persistence/session.js');
      const store = getDefaultSessionStore();
      const all = await store.list(opts.status ? { status: opts.status as never } : undefined);
      if (opts.json) {
        process.stdout.write(JSON.stringify(all, null, 2) + '\n');
      } else {
        if (all.length === 0) {
          process.stdout.write('No sessions\n');
        } else {
          for (const r of all.sort((a, b) => b.updatedAt - a.updatedAt)) {
            process.stdout.write(formatSession(r) + '\n');
          }
        }
      }
    });
  session
    .command('show <id>')
    .description('Show session transcript and observations')
    .option('--json', 'Output JSON')
    .action(async (id: string, opts: { json?: boolean }) => {
      const { getDefaultSessionStore, resolveSessionId } = await import('./persistence/session.js');
      const store = getDefaultSessionStore();
      const full = await resolveSessionId(store, id);
      if (!full) {
        process.stderr.write(`session not found: ${id}\n`);
        process.exit(2);
      }
      const rec = await store.get(full);
      const msgs = await store.loadMessages(full);
      const obs = await store.loadObservations(full);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ record: rec, messages: msgs, observations: obs }, null, 2) + '\n');
      } else {
        process.stdout.write(`Session ${rec?.id}\n  task: ${rec?.task}\n  status: ${rec?.status}\n  cwd: ${rec?.cwd}\n  created: ${new Date(rec?.createdAt ?? 0).toISOString()}\n`);
        process.stdout.write(`\nMessages (${msgs.length}):\n`);
        for (const m of msgs) process.stdout.write(`  [${m.role}] ${JSON.stringify(m.content).slice(0, 200)}\n`);
        process.stdout.write(`\nObservations (${obs.length}):\n`);
        for (const o of obs) process.stdout.write(`  ${o.toolName} -> ${o.isError ? 'ERR' : 'ok'} ${JSON.stringify(o.output).slice(0, 120)}\n`);
      }
    });
  session
    .command('resume <id>')
    .description('Resume a persisted session (requires KLYRO_MODEL etc.)')
    .option('-m, --model <id>', 'Model (default: from session or env)')
    .option('--max-steps <n>', 'Max steps (default 30)', (v) => parsePositiveInt('--max-steps', v))
    .option('--verify-command <cmd>', 'Override verification command')
    .option('--verify', 'Enable verification (default: enabled)')
    .action(async (id: string, opts: { model?: string; maxSteps?: number; verifyCommand?: string; verify?: boolean }) => {
      const { getDefaultSessionStore, resolveSessionId } = await import('./persistence/session.js');
      const store = getDefaultSessionStore();
      const full = await resolveSessionId(store, id);
      if (!full) {
        process.stderr.write(`session not found: ${id}\n`);
        process.exit(2);
      }
      const rec = await store.get(full);
      if (!rec) {
        process.stderr.write(`session not found: ${id}\n`);
        process.exit(2);
      }
      const model = opts.model ?? rec.config.model ?? process.env.KLYRO_MODEL;
      if (!model) {
        process.stderr.write('klyro: KLYRO_MODEL is not set (or pass --model)\n');
        process.exit(2);
      }
      const code = await runOnce({
        task: rec.task,
        cwd: rec.cwd,
        model,
        maxSteps: opts.maxSteps ?? rec.config.maxSteps,
        sessionId: full,
        verify: opts.verify,
        verifyCommand: opts.verifyCommand,
      });
      process.exit(code);
    });

  // Alias: klyro resume <id> → klyro session resume <id>
  program
    .command('resume <id>')
    .description('Alias for `klyro session resume <id>`')
    .option('-m, --model <id>', 'Model')
    .option('--max-steps <n>', 'Max steps', (v) => parsePositiveInt('--max-steps', v))
    .action(async (id: string, opts: { model?: string; maxSteps?: number }) => {
      const { getDefaultSessionStore, resolveSessionId } = await import('./persistence/session.js');
      const store = getDefaultSessionStore();
      const full = await resolveSessionId(store, id);
      if (!full) {
        process.stderr.write(`session not found: ${id}\n`);
        process.exit(2);
      }
      const rec = await store.get(full);
      if (!rec) {
        process.stderr.write(`session not found: ${id}\n`);
        process.exit(2);
      }
      const model = opts.model ?? rec.config.model ?? process.env.KLYRO_MODEL;
      if (!model) {
        process.stderr.write('klyro: KLYRO_MODEL is not set (or pass --model)\n');
        process.exit(2);
      }
      const code = await runOnce({
        task: rec.task,
        cwd: rec.cwd,
        model,
        maxSteps: opts.maxSteps ?? rec.config.maxSteps,
        sessionId: full,
      });
      process.exit(code);
    });

  program.command('scan').description('Scan project (7.1) — languages, frameworks, commands, 300ms cached').option('--json', 'JSON output').action(async (opts: { json?: boolean }) => { const { runScan } = await import('./cli/scan.js'); process.exit(await runScan({ cwd: process.cwd(), json: !!opts.json })); });
  program.command('project').description('Alias for scan').option('--json', 'JSON output').action(async (opts: { json?: boolean }) => { const { runProject } = await import('./cli/scan.js'); process.exit(await runProject({ cwd: process.cwd(), json: !!opts.json })); });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  // Last-resort: anything that escaped the command handlers lands here.
  // eslint-disable-next-line no-console
  console.error(`klyro: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
