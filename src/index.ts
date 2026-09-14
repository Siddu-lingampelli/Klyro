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
import { readVersion } from './version.js';
import { verifyAuditChain } from './persistence/audit.js';

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
    .option('--yes', 'Auto-approve commit prompts (scope: `klyro commit` only)')
    .option('--no-color', 'Disable colored output')
    .option('-p, --print <prompt>', 'Headless one-shot prompt (alias for run, --output json for machine)')
    .option('--output-format <fmt>', 'Headless output format: text|json|stream-json (default text)')
    .option('--temperature <n>', 'Sampling temperature 0-2 (headless -p / run)', parseTemperature)
    .option('--max-tokens <n>', 'Max output tokens per step (headless -p / run)', (v) => parsePositiveInt('--max-tokens', v))
    .option('--no-stream', 'Disable streaming (TUI only; headless json always streams events)')
    .option('--show-thinking', 'Show thinking blocks (TUI only)');

  // Unknown commands / unknown options are usage errors (exit 2 per PRD).
  // Help and version still exit 0; anything else rethrows to the last-resort
  // handler (exit 1).
  program.exitOverride((err) => {
    if (err.code === 'commander.unknownCommand' || err.code === 'commander.unknownOption') {
      process.stderr.write(`klyro: ${err.message}\n`);
      process.exit(2);
    }
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      process.exit(0);
    }
    throw err;
  });

  // Handle global flags before any command runs
  program.hook('preAction', async (thisCommand) => {
    const opts = thisCommand.optsWithGlobals<{ cwd?: string; config?: string; debug?: boolean; verbose?: boolean; quiet?: boolean; json?: boolean; yes?: boolean; color?: boolean }>();
    if (opts.cwd) {
      try {
        process.chdir(opts.cwd);
      } catch (err) {
        process.stderr.write(`klyro: --cwd: cannot chdir to ${opts.cwd}: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(2);
      }
    }
    // Load <cwd>/.env globally (after chdir) so KLYRO_* vars resolve for
    // every command. Never throws; explicit env wins (no-clobber).
    try {
      const { loadDotenv } = await import('./cli/dotenv.js');
      loadDotenv(process.cwd());
    } catch { /* ignore */ }
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
    .option('--apply', 'Apply the update now via npm i -g (opt-in; default is notify-only)')
    .action(async (opts: { apply?: boolean }) => {
      const code = await runUpdate({ apply: !!opts.apply });
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

  program
    .command('init')
    .description('Bootstrap this project: scan + KLYRO.md draft + .mcp.json skeleton (never overwrites)')
    .action(async () => {
      const { initProject, nextStepsText } = await import('./cli/init.js');
      try {
        const { created, skipped } = await initProject(process.cwd());
        for (const f of created) process.stdout.write(`created ${f}\n`);
        for (const f of skipped) process.stdout.write(`kept ${f}\n`);
        process.stdout.write(nextStepsText() + '\n');
        process.exit(0);
      } catch (err) {
        process.stderr.write(`klyro: init failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // Support `klyro "prompt"` positional headless (2.5)
  program.argument('[prompt]', 'Headless one-shot prompt (same as -p)');

  program
    .action(async (promptArg?: string) => {
            const opts = program.opts<{ tui?: boolean; chat?: boolean; print?: string; outputFormat?: string; json?: boolean; maxTokens?: number; temperature?: number; stream?: boolean; continue?: boolean; resume?: string | boolean }>();      // 9.2 — --continue / --resume handling
      if (opts.continue || typeof opts.resume === 'string') {
        const { getDefaultSessionStore } = await import('./persistence/session.js');
        const store = getDefaultSessionStore();
        const all = (await store.list()).filter((r) => r.cwd === process.cwd()).sort((a, b) => b.updatedAt - a.updatedAt);
        const target = typeof opts.resume === 'string' ? all.find((r) => r.id.startsWith(opts.resume as string)) ?? all[0] : all[0];
        if (!target) { process.stderr.write('klyro: no session to continue in this cwd (try klyro session list)\n'); process.exit(2); }
        process.stderr.write(`klyro: continuing session ${target.id.slice(0, 8)} — ${target.task}\n`);
        const model = process.env.KLYRO_MODEL ?? target.config.model;
        if (!model) { process.stderr.write('klyro: KLYRO_MODEL not set\n'); process.exit(2); }
        const code = await runOnce({ task: target.task, cwd: target.cwd, model, maxSteps: target.config.maxSteps, sessionId: target.id });
        process.exit(code);
      }
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
          temperature: opts.temperature,
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
    .option('--verify-mode <mode>', 'Verification mode: strict (default), advisory, off')
    .option('--max-repairs <n>', 'Max autonomous repair attempts (default 3)', (v) => parsePositiveInt('--max-repairs', v))
    .option('--persist', 'Enable session persistence (Level 9, default: enabled)')
    .option('--require-verify', 'Fail with exit 8 if no verification passed after edits (6.5)')
    .option('--agent <name>', 'Run under an orchestrator context enabling spawn_agent/task_list/task_get (explorer|implementer|tester|reviewer)')
    .option('--max-depth <n>', 'Max spawn depth for child agents (default 1)', (v) => parsePositiveInt('--max-depth', v))
    .option('--bare', 'Deterministic runs: skip MCP, hooks, memory/KLYRO.md/context, persistence')
    .action(async (prompt: string, opts: {
      model?: string; maxSteps?: number; maxTokens?: number; temperature?: number;
      timeout?: number; baseUrl?: string; apiKey?: string;
      output?: string; dryRun?: boolean; provider?: string; resume?: string;
      resumeSession?: string; verify?: boolean; verifyCommand?: string; verifyMode?: string; maxRepairs?: number; persist?: boolean; requireVerify?: boolean;
      agent?: string; maxDepth?: number; bare?: boolean;
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
      const verifyMode = opts.verifyMode ?? 'strict';
      if (verifyMode !== 'strict' && verifyMode !== 'advisory' && verifyMode !== 'off') {
        process.stderr.write(`klyro: invalid --verify-mode: ${opts.verifyMode} (expected strict|advisory|off)\n`);
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
          verifyMode: verifyMode as import('./agent/runtime.js').VerifyMode,
          maxRepairAttempts: opts.maxRepairs,
          persist: opts.persist,
          requireVerify: !!opts.requireVerify,
          agent: opts.agent,
          maxDepth: opts.maxDepth,
          bare: !!opts.bare,
        });
        process.exit(code);
      } catch (err) {
        process.stderr.write(`klyro: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(2);
      }
    });

  program
    .command('chat [prompt]')
    .description('Legacy streamed chat. Without a prompt, start an interactive REPL. (deprecated: history truncation is approximate; prefer `klyro tui`)')
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
    .option('--judge-model <id>', 'Live model id for grading judge.rubric (needs endpoint + key)')
    .action(async (input: string | undefined, opts: { output?: string; suite?: string; filter?: string; runs?: number; parallel?: number; model?: string; judgeModel?: string }) => {
      const output = (opts.output ?? 'human') as 'human' | 'json' | 'silent';
      if (opts.suite) {
        const code = await runEval({ inputPath: input ?? '-', output, suite: opts.suite, filter: opts.filter, runs: opts.runs, parallel: opts.parallel, model: opts.model, judgeModel: opts.judgeModel });
        process.exit(code);
      }
      if (!input) {
        process.stderr.write('klyro eval: missing input (provide <input> or --suite)\n');
        process.exit(2);
      }
      const code = await runEval({ inputPath: input, output, suite: opts.suite, filter: opts.filter, runs: opts.runs, parallel: opts.parallel, model: opts.model, judgeModel: opts.judgeModel });
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

  // Level 9 — Session management.
  // One namespace: `session` and `sessions` accept the SAME subcommands
  // (list/show/resume/export/import/fork/delete). Handlers live here once
  // and both command groups delegate to them.
  async function sessionList(opts: { status?: string; json?: boolean }): Promise<void> {
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
  }
  async function resolveOrExit(id: string): Promise<string> {
    const { getDefaultSessionStore, resolveSessionId, matchSessionIds } = await import('./persistence/session.js');
    const store = getDefaultSessionStore();
    const full = await resolveSessionId(store, id);
    if (full) return full;
    const matches = await matchSessionIds(store, id);
    if (matches.length > 1) {
      process.stderr.write(`ambiguous id "${id}" matches:\n${matches.map((r) => `  ${r.id.slice(0, 8)}  ${r.task.slice(0, 50)}`).join('\n')}\n`);
    } else {
      process.stderr.write(`session not found: ${id}\n`);
    }
    process.exit(2);
  }
  async function sessionShow(id: string, opts: { json?: boolean }): Promise<void> {
    const { getDefaultSessionStore } = await import('./persistence/session.js');
    const store = getDefaultSessionStore();
    const full = await resolveOrExit(id);
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
  }
  async function sessionResume(id: string, opts: { model?: string; maxSteps?: number; verifyCommand?: string; verify?: boolean }): Promise<void> {
    const { getDefaultSessionStore } = await import('./persistence/session.js');
    const store = getDefaultSessionStore();
    const full = await resolveOrExit(id);
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
  }
  async function sessionExport(id: string, file?: string): Promise<void> {
    const { getDefaultSessionStore } = await import('./persistence/session.js');
    const store = getDefaultSessionStore();
    const full = await resolveOrExit(id);
    const rec = await store.get(full); const msgs = await store.loadMessages(full); const obs = await store.loadObservations(full);
    const out = file ?? `${full}.export.json`; await (await import('node:fs/promises')).writeFile(out, JSON.stringify({ record: rec, messages: msgs, observations: obs }, null, 2)); process.stdout.write(`exported ${full} → ${out}\n`);
  }
  async function sessionImport(file: string): Promise<void> {
    let data: unknown;
    try {
      data = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf-8'));
    } catch (err) {
      process.stderr.write(`klyro: cannot import ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
    const rec = (data as { record?: { cwd?: unknown; task?: unknown; config?: unknown } }).record ?? {};
    const { getDefaultSessionStore } = await import('./persistence/session.js'); const store = getDefaultSessionStore();
    const cfg = (rec.config && typeof rec.config === 'object' ? rec.config : { model: 'imported', maxSteps: 30 }) as { model: string; maxSteps: number };
    const created = await store.create({ cwd: typeof rec.cwd === 'string' ? rec.cwd : process.cwd(), task: typeof rec.task === 'string' ? rec.task : 'imported', config: cfg });
    // Restore the transcript — previously this was silently dropped (lossy
    // import). Messages/observations go through append* so at-rest redaction
    // still applies. Malformed entries fail loudly instead of half-importing.
    const d = data as { messages?: unknown; observations?: unknown };
    let restored = 0;
    if (d.messages !== undefined) {
      if (!Array.isArray(d.messages)) { process.stderr.write(`klyro: import failed: "messages" is not an array in ${file}\n`); process.exit(2); }
      for (const m of d.messages) {
        if (!m || typeof m !== 'object' || typeof (m as { role?: unknown }).role !== 'string' || !('content' in (m as object))) {
          process.stderr.write(`klyro: import failed: malformed message entry in ${file}\n`); process.exit(2);
        }
        await store.appendMessage(created.id, m as never);
        restored++;
      }
    }
    if (d.observations !== undefined) {
      if (!Array.isArray(d.observations)) { process.stderr.write(`klyro: import failed: "observations" is not an array in ${file}\n`); process.exit(2); }
      for (const o of d.observations) {
        if (!o || typeof o !== 'object') { process.stderr.write(`klyro: import failed: malformed observation entry in ${file}\n`); process.exit(2); }
        await store.appendObservation(created.id, o as never);
      }
    }
    process.stdout.write(`imported → ${created.id} (${restored} messages restored)\n`);
  }
  async function sessionFork(id: string): Promise<void> {
    const { getDefaultSessionStore, matchSessionIds } = await import('./persistence/session.js'); const store = getDefaultSessionStore(); const matches = await matchSessionIds(store, id);
    if (matches.length === 0) { process.stderr.write(`session not found: ${id}\n`); process.exit(2); }
    if (matches.length > 1) { process.stderr.write(`ambiguous id "${id}" matches:\n${matches.map((r) => `  ${r.id.slice(0, 8)}  ${r.task.slice(0, 50)}`).join('\n')}\n`); process.exit(2); }
    const full = matches[0]!.id;
    const forked = await store.fork(full);
    const msgs = await store.loadMessages(forked.id);
    process.stdout.write(`forked ${full.slice(0, 8)} → ${forked.id.slice(0, 8)} (${msgs.length} messages carried over)\n`);
  }
  async function sessionDelete(id: string): Promise<void> {
    const { getDefaultSessionStore, matchSessionIds } = await import('./persistence/session.js'); const store = getDefaultSessionStore(); const matches = await matchSessionIds(store, id);
    if (matches.length === 0) { process.stderr.write(`session not found: ${id}\n`); process.exit(2); }
    if (matches.length > 1) { process.stderr.write(`ambiguous id "${id}" matches:\n${matches.map((r) => `  ${r.id.slice(0, 8)}  ${r.task.slice(0, 50)}`).join('\n')}\n`); process.exit(2); }
    const full = matches[0]!.id;
    await store.delete(full);
    process.stdout.write(`deleted ${full.slice(0, 8)}\n`);
  }
  const session = program.command('session').description('Session persistence (Level 9)');
  session
    .command('list')
    .description('List persisted sessions')
    .option('--status <s>', 'Filter by status: open|complete|verify_failed|aborted|max_steps')
    .option('--json', 'Output JSON')
    .action(async (opts: { status?: string; json?: boolean }) => { await sessionList(opts); });
  session
    .command('show <id>')
    .description('Show session transcript and observations')
    .option('--json', 'Output JSON')
    .action(async (id: string, opts: { json?: boolean }) => { await sessionShow(id, opts); });
  session
    .command('resume <id>')
    .description('Resume a persisted session (requires KLYRO_MODEL etc.)')
    .option('-m, --model <id>', 'Model (default: from session or env)')
    .option('--max-steps <n>', 'Max steps (default 30)', (v) => parsePositiveInt('--max-steps', v))
    .option('--verify-command <cmd>', 'Override verification command')
    .option('--verify', 'Enable verification (default: enabled)')
    .action(async (id: string, opts: { model?: string; maxSteps?: number; verifyCommand?: string; verify?: boolean }) => { await sessionResume(id, opts); });
  session
    .command('export <id> [file]')
    .description('Export session to file (9.4)')
    .action(async (id: string, file?: string) => { await sessionExport(id, file); });
  session
    .command('import <file>')
    .description('Import session from file (restores record + messages + observations)')
    .action(async (file: string) => { await sessionImport(file); });
  session
    .command('fork <id>')
    .description('Fork session with full context (9.4)')
    .action(async (id: string) => { await sessionFork(id); });
  session
    .command('delete <id>')
    .description('Delete a session and its artifacts')
    .action(async (id: string) => { await sessionDelete(id); });

  // Alias: klyro resume <id> → klyro session resume <id>
  program
    .command('resume <id>')
    .description('Alias for `klyro session resume <id>`')
    .option('-m, --model <id>', 'Model')
    .option('--max-steps <n>', 'Max steps', (v) => parsePositiveInt('--max-steps', v))
    .action(async (id: string, opts: { model?: string; maxSteps?: number }) => { await sessionResume(id, opts); });

  program.command('scan').description('Scan project (7.1) — languages, frameworks, commands, 300ms cached').option('--json', 'JSON output').action(async (opts: { json?: boolean }) => { const { runScan } = await import('./cli/scan.js'); process.exit(await runScan({ cwd: process.cwd(), json: !!opts.json })); });
  program.command('project').description('Alias for scan').option('--json', 'JSON output').action(async (opts: { json?: boolean }) => { const { runProject } = await import('./cli/scan.js'); process.exit(await runProject({ cwd: process.cwd(), json: !!opts.json })); });

  // 9.2 — Continue / resume top-level flags (also handled via session resume)
  program.option('-c, --continue', 'Continue most recent session in cwd (9.2)');
  program.option('-r, --resume [id]', 'Resume session by id or pick most recent');

  // 9.4 — same namespace as `session`: every subcommand works under both.
  const sessions = program.command('sessions').description('Alias for session (same subcommands)');
  sessions.command('list').description('List persisted sessions').option('--status <s>', 'Filter by status').option('--json', 'Output JSON').action(async (opts: { status?: string; json?: boolean }) => { await sessionList(opts); });
  sessions.command('show <id>').description('Show session transcript and observations').option('--json', 'Output JSON').action(async (id: string, opts: { json?: boolean }) => { await sessionShow(id, opts); });
  sessions.command('resume <id>').description('Resume a persisted session').option('-m, --model <id>', 'Model').option('--max-steps <n>', 'Max steps', (v) => parsePositiveInt('--max-steps', v)).option('--verify-command <cmd>', 'Override verification command').option('--verify', 'Enable verification (default: enabled)').action(async (id: string, opts: { model?: string; maxSteps?: number; verifyCommand?: string; verify?: boolean }) => { await sessionResume(id, opts); });
  sessions.command('export <id> [file]').description('Export session to file (9.4)').action(async (id: string, file?: string) => { await sessionExport(id, file); });
  sessions.command('import <file>').description('Import session from file (restores record + messages + observations)').action(async (file: string) => { await sessionImport(file); });
  sessions.command('fork <id>').description('Fork session with full context (9.4)').action(async (id: string) => { await sessionFork(id); });
  sessions.command('delete <id>').description('Delete a session and its artifacts').action(async (id: string) => { await sessionDelete(id); });

  // 10.1 — MCP
  const mcp = program.command('mcp').description('MCP client/server (10.1)');
  mcp.command('list').description('List MCP servers').action(async () => {
    const { loadMcpServers } = await import('./mcp/config.js');
    const cfg = loadMcpServers(process.cwd());
    const names = Object.keys(cfg.servers);
    if (names.length === 0) {
      process.stdout.write('mcp servers: none configured (use .mcp.json)\n');
      return;
    }
    for (const name of names) {
      const spec = cfg.servers[name];
      const source = cfg.sources[name] ?? 'unknown';
      process.stdout.write(`${name} source=${source}${spec?.disabled ? ' disabled' : ''}\n`);
    }
  });
  mcp.command('add <name> <command> [args...]').description('Add a project MCP server to .mcp.json (stdio command, or https:// URL for remote)').action(async (name: string, command: string, args: string[]) => {
    const { addProjectServer, projectMcpPath } = await import('./mcp/config.js');
    try {
      // URL first arg → remote Streamable-HTTP server; else stdio command.
      const spec = /^https?:\/\//i.test(command)
        ? { url: command }
        : { command, ...(args && args.length > 0 ? { args } : {}) };
      addProjectServer(process.cwd(), name, spec);
      process.stdout.write(`added mcp server "${name}" → ${projectMcpPath(process.cwd())}\n`);
    } catch (err) {
      process.stderr.write(`klyro: mcp add failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
  });
  mcp.command('remove <name>').description('Remove a project MCP server from .mcp.json').action(async (name: string) => {
    const { removeProjectServer, projectMcpPath } = await import('./mcp/config.js');
    try {
      if (!removeProjectServer(process.cwd(), name)) {
        process.stderr.write(`klyro: mcp server not found in ${projectMcpPath(process.cwd())}: ${name}\n`);
        process.exit(2);
      }
      process.stdout.write(`removed mcp server "${name}"\n`);
    } catch (err) {
      process.stderr.write(`klyro: mcp remove failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
  });
  mcp.command('probe <name>').description('Connect to an MCP server (15s timeout), list its tools, print count+names').action(async (name: string) => {
    const { loadMcpServers } = await import('./mcp/config.js');
    const cfg = loadMcpServers(process.cwd());
    const spec = cfg.servers[name];
    if (!spec) {
      process.stderr.write(`klyro: mcp server not found: ${name}\n`);
      process.exit(2);
    }
    const { makeMcpClient } = await import('./mcp/registry.js');
    const client = makeMcpClient(name, spec);    // 15s overall probe budget (connect has its own internal timeout too).
    const timer = setTimeout(() => {
      process.stderr.write(`klyro: mcp probe ${name} timed out after 15s\n`);
      process.exit(2);
    }, 15_000);
    try {
      const withConnect = client as Partial<{ connect: () => Promise<void> }>;
      if (typeof withConnect.connect === 'function') await withConnect.connect();
      const tools = await client.listTools();
      const prompts = typeof client.promptsList === 'function' ? await client.promptsList().catch(() => []) : [];
      const names = tools.map((t) => t.name);
      const extra = prompts.length > 0 ? `, ${prompts.length} prompt(s): ${prompts.map((p) => p.name).join(', ')}` : '';
      process.stdout.write(`${name}: ${tools.length} tool(s)${names.length > 0 ? `: ${names.join(', ')}` : ''}${extra}\n`);
      process.exit(0);
    } catch (err) {
      process.stderr.write(`klyro: mcp probe ${name} failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    } finally {
      clearTimeout(timer);
      try { await client.close(); } catch { /* ignore */ }
    }
  });
  mcp.command('trust <name>').description('Trust a project MCP server spec (records its hash, enables auto-connect)').action(async (name: string) => {
    const { loadMcpServers } = await import('./mcp/config.js');
    const { McpTrust, hashSpec } = await import('./mcp/trust.js');
    const cfg = loadMcpServers(process.cwd());
    const spec = cfg.servers[name];
    if (!spec) {
      process.stderr.write(`klyro: mcp server not found: ${name}\n`);
      process.exit(2);
    }
    new McpTrust().approve(name, hashSpec(spec));
    process.stdout.write(`trusted mcp server "${name}" (source=${cfg.sources[name] ?? 'unknown'})\n`);
  });
  mcp.command('prompts [server]').description('List MCP prompts as /mcp__<server>__<prompt> slash names').action(async (server?: string) => {
    const { loadMcpServers, enabledServers } = await import('./mcp/config.js');
    const { makeMcpClient } = await import('./mcp/registry.js');
    const cfg = loadMcpServers(process.cwd());
    const targets = server ? [server] : Object.keys(enabledServers(cfg));
    if (targets.length === 0) {
      process.stdout.write('mcp prompts: none (no servers configured)\n');
      return;
    }
    let shown = 0;
    for (const name of targets) {
      const spec = cfg.servers[name];
      if (!spec) {
        process.stderr.write(`klyro: mcp server not found: ${name}\n`);
        continue;
      }
      const client = makeMcpClient(name, spec);
      try {
        const withConnect = client as Partial<{ connect: () => Promise<void> }>;
        if (typeof withConnect.connect === 'function') await withConnect.connect();
        const prompts = typeof client.promptsList === 'function' ? await client.promptsList() : [];
        for (const p of prompts) {
          process.stdout.write(`/mcp__${name}__${p.name}${p.description ? ` — ${p.description}` : ''}\n`);
          shown++;
        }
      } catch (err) {
        process.stderr.write(`klyro: mcp prompts ${name} failed: ${err instanceof Error ? err.message : String(err)}\n`);
      } finally {
        try { await client.close(); } catch { /* ignore */ }
      }
    }
    if (shown === 0) process.stdout.write('mcp prompts: none exposed by configured servers\n');
  });
  mcp.command('serve').description('Serve builtin tools as an MCP server over stdio (policy-gated)').action(async () => {    const { serveStdio } = await import('./mcp/serve.js');
    const code = await serveStdio(process.cwd());
    process.exit(code);
  });

  // 10.2 — Hooks: list configured preToolUse/postToolUse hooks.
  program.command('hooks [cmd]').description('Hooks (10.2): `klyro hooks` or `klyro hooks list` prints configured hooks').action(async (cmd?: string) => {
    if (cmd && cmd !== 'list') {
      process.stderr.write(`klyro: unknown hooks command: ${cmd} (usage: klyro hooks [list])\n`);
      process.exit(2);
    }
    const { loadHooks } = await import('./cli/hooks.js');
    const hooks = loadHooks(process.cwd());
    if (hooks.length === 0) {
      process.stdout.write('hooks: none configured (.klyro/hooks.json, ~/.klyro/hooks.json)\n');
      return;
    }
    for (const h of hooks) process.stdout.write(`${h.name} ${h.event}${h.matcher ? ` (${h.matcher})` : ''} ${h.command}\n`);
  });
  program.command('agents [name] [extra...]').description('List agents (builtins + .klyro/agents/*.md), show one, lint files, or run: agents run <name> <task...>').action(async (name?: string, extra?: string[]) => {
    const { listAllAgents } = await import('./agent/orchestrator.js');
    const ALL = listAllAgents(process.cwd());
    // `klyro agents lint`: validate custom agent files (ids, tool names).
    if (name === 'lint') {
      const { loadCustomAgents } = await import('./agent/custom-agents.js');
      const { builtinRegistry } = await import('./tools/registry.js');
      const known = new Set(builtinRegistry().list().map((t) => t.name));
      const customs = loadCustomAgents(process.cwd());
      if (customs.length === 0) {
        process.stdout.write('agents lint: no custom agents in .klyro/agents/ (or ~/.klyro/agents/)\n');
        return;
      }
      let bad = 0;
      for (const a of customs) {
        const problems: string[] = [];
        if (!a.description || a.description === `Custom agent ${a.id}`) problems.push('missing description');
        for (const t of a.allowedTools ?? []) {
          if (!known.has(t)) problems.push(`unknown tool "${t}" (will be dropped at spawn)`);
        }
        if (!a.prompt && !(a.allowedTools ?? []).length) problems.push('no prompt body and no tools — agent has no specialization');
        if (problems.length > 0) {
          bad++;
          process.stdout.write(`${a.id} (${a.source ?? 'custom'}):\n${problems.map((p) => `  ! ${p}`).join('\n')}\n`);
        } else {
          process.stdout.write(`${a.id} (${a.source ?? 'custom'}): ok\n`);
        }
      }
      if (bad > 0) process.exit(2);
      return;
    }
    // `klyro agents run <name> <task...>`: one-shot run under a named agent.
    if (name === 'run') {
      const [agentName, ...taskParts] = extra ?? [];
      if (!agentName || !ALL.some((a) => a.id === agentName)) {
        process.stderr.write(`klyro: unknown agent: ${agentName ?? '(missing)'} (known: ${ALL.map((a) => a.id).join(', ')})\n`);
        process.exit(2);
      }
      const task = (taskParts ?? []).join(' ').trim();
      if (!task) {
        process.stderr.write('klyro: agents run requires a task (usage: klyro agents run <name> <task...>)\n');
        process.exit(2);
      }
      const model = process.env.KLYRO_MODEL;
      if (!model) {
        process.stderr.write('klyro: KLYRO_MODEL is not set (or pass --model via klyro run)\n');
        process.exit(2);
      }
      const code = await runOnce({ task, cwd: process.cwd(), model, agent: agentName });
      process.exit(code);
    }
    if (!name) {
      for (const a of ALL) process.stdout.write(`${a.id}${a.source && a.source !== 'builtin' ? ` (${a.source})` : ''} — ${a.description}\n`);
      return;
    }
    const def = ALL.find((a) => a.id === name);
    if (!def) {
      process.stderr.write(`klyro: unknown agent: ${name} (known: ${ALL.map((a) => a.id).join(', ')})\n`);
      process.exit(2);
    }
    const tools = def.allowedTools ?? ['<inherited: all parent tools>'];
    const lines = [
      `agent: ${def.id}`,
      `description: ${def.description}`,
      `source: ${def.source ?? 'builtin'}`,
      `tools (${tools.length}): ${tools.join(', ')}`,
      `readonly: ${def.readonly ?? false}`,
      `canSpawn: ${def.canSpawn ?? false}`,
      `model: ${def.model ?? '<session default>'}`,
      `maxSteps: ${def.maxSteps ?? '<default>'}`,
      `maxTokens: ${def.maxTokens ?? '<default>'}`,
    ];
    if (def.prompt) lines.push(`prompt: ${def.prompt.slice(0, 200)}${def.prompt.length > 200 ? '…' : ''}`);
    process.stdout.write(lines.join('\n') + '\n');
  });

  // 10.3 — Web / git workflows / SDK
  program
    .command('commit')
    .description('Commit staged changes with a conventional message (verification hooks always run)')
    .option('--dry-run', 'Print the message + files without committing')
    .option('--message <msg>', 'Summary for the conventional message (default: update <n> files)')
    .option('--force-secret', 'Commit even if the staged diff looks like it contains a secret')
    .action(async (opts: { dryRun?: boolean; message?: string; forceSecret?: boolean }) => {
      const { runCommit } = await import('./cli/commit.js');
      const globalYes = program.opts<{ yes?: boolean }>().yes ?? process.env.KLYRO_YES === '1';
      const code = await runCommit({
        cwd: process.cwd(),
        yes: !!globalYes,
        dryRun: !!opts.dryRun,
        ...(opts.message !== undefined ? { message: opts.message } : {}),
        forceSecret: !!opts.forceSecret,
      });
      process.exit(code);
    });
  program.command('audit [session]').description('Verify audit chain (13.4)').action(async (session?: string) => {
    if (!session) {
      process.stderr.write('klyro: audit requires a session id (usage: klyro audit <session>)\n');
      process.exit(2);
    }
    try {
      const { getDefaultSessionsDir } = await import('./persistence/session.js');
      const res = await verifyAuditChain(getDefaultSessionsDir(), session);
      if (res.ok) {
        process.stdout.write(`audit ok: ${res.events} events verified\n`);
        process.exit(0);
      }
      process.stderr.write(`klyro: audit failed: ${res.error ?? 'chain broken'}\n`);
      process.exit(1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`klyro: audit failed: ${msg}\n`);
      process.exit(1);
    }
  });

  // 10.4 — Benchmark parity (10.5)
  program.command('benchmark').description('Run benchmark (10.5)').action(async () => {
    const { runHarness } = await import('./eval/harness.js'); const summary = await runHarness([]); process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  // Last-resort: anything that escaped the command handlers lands here.
  // eslint-disable-next-line no-console
  console.error(`klyro: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
