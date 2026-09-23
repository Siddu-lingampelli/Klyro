import type { Command } from 'commander';
import { runOnce } from './run.js';
import { parsePositiveInt } from './args.js';

/**
 * Session command namespace (extracted from src/index.ts entrypoint).
 *
 * `session` and `sessions` accept the SAME subcommands
 * (list/show/resume/export/import/fork/delete); `resume` is an alias for
 * `session resume`. Handlers live here once and all groups delegate.
 */
export function registerSessionCommands(program: Command): void {
  // Level 9 — Session management.
  // One namespace: `session` and `sessions` accept the SAME subcommands
  // (list/show/resume/export/import/fork/delete). Handlers live here once
  // and both command groups delegate to them.
  async function sessionList(opts: { status?: string; json?: boolean }): Promise<void> {
    const { getDefaultSessionStore, formatSession } = await import('../persistence/session.js');
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
    const { getDefaultSessionStore, resolveSessionId, matchSessionIds } = await import('../persistence/session.js');
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
    const { getDefaultSessionStore } = await import('../persistence/session.js');
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
    const { getDefaultSessionStore } = await import('../persistence/session.js');
    const store = getDefaultSessionStore();
    const full = await resolveOrExit(id);
    const rec = await store.get(full);
    if (!rec) {
      process.stderr.write(`session not found: ${id}\n`);
      process.exit(2);
    }
    // Resume precondition (review §9): the session is bound to the cwd /
    // worktree it was created in. Resuming from a different directory
    // continues in the ORIGINAL cwd (authoritative) but warns loudly so a
    // moved checkout or wrong terminal cannot silently continue elsewhere.
    if (rec.cwd !== process.cwd()) {
      process.stderr.write(
        `klyro: warning: session created in ${rec.cwd}, resuming there (current dir is ${process.cwd()})\n`,
      );
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
    const { getDefaultSessionStore } = await import('../persistence/session.js');
    const store = getDefaultSessionStore();
    const full = await resolveOrExit(id);
    const rec = await store.get(full); const msgs = await store.loadMessages(full); const obs = await store.loadObservations(full);
    const out = file ?? `${full}.export.json`; await (await import('node:fs/promises')).writeFile(out, JSON.stringify({ record: rec, messages: msgs, observations: obs }, null, 2)); process.stdout.write(`exported ${full} → ${out}\n`);
  }
  async function sessionImport(file: string): Promise<void> {
    let data: unknown;
    try {
      const { stripBom } = await import('../shared/json.js');
      data = JSON.parse(stripBom(await (await import('node:fs/promises')).readFile(file, 'utf-8')));
    } catch (err) {
      process.stderr.write(`klyro: cannot import ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
    const rec = (data as { record?: { cwd?: unknown; task?: unknown; config?: unknown } }).record ?? {};
    const { getDefaultSessionStore } = await import('../persistence/session.js'); const store = getDefaultSessionStore();
    // Validate config shape (model string, bounded maxSteps) — an imported
    // file is untrusted input and must not inject arbitrary session config.
    const rawCfg = (rec.config && typeof rec.config === 'object' ? rec.config : { model: 'imported', maxSteps: 30 }) as { model?: unknown; maxSteps?: unknown };
    const cfg = {
      model: typeof rawCfg.model === 'string' && rawCfg.model.length > 0 && rawCfg.model.length <= 200 ? rawCfg.model : 'imported',
      maxSteps: typeof rawCfg.maxSteps === 'number' && Number.isFinite(rawCfg.maxSteps) && rawCfg.maxSteps > 0 && rawCfg.maxSteps <= 500 ? Math.floor(rawCfg.maxSteps) : 30,
    };
    const taskStr = typeof rec.task === 'string' ? rec.task.slice(0, 20_000) : 'imported';
    const created = await store.create({ cwd: typeof rec.cwd === 'string' ? rec.cwd : process.cwd(), task: taskStr, config: cfg });
    // Restore the transcript — previously this was silently dropped (lossy
    // import). Messages/observations go through append* so at-rest redaction
    // still applies. Malformed entries fail loudly instead of half-importing.
    // Caps: at most 5000 messages / 2000 observations — an import file is
    // untrusted and must not exhaust memory or disk.
    const d = data as { messages?: unknown; observations?: unknown };
    let restored = 0;
    if (d.messages !== undefined) {
      if (!Array.isArray(d.messages)) { process.stderr.write(`klyro: import failed: "messages" is not an array in ${file}\n`); process.exit(2); }
      if (d.messages.length > 5000) { process.stderr.write(`klyro: import failed: too many messages (${d.messages.length} > 5000) in ${file}\n`); process.exit(2); }
      for (const m of d.messages) {
        const role = (m as { role?: unknown } | null)?.role;
        if (!m || typeof m !== 'object' || (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'system') || !('content' in (m as object))) {
          process.stderr.write(`klyro: import failed: malformed message entry in ${file}\n`); process.exit(2);
        }
        await store.appendMessage(created.id, m as never);
        restored++;
      }
    }
    if (d.observations !== undefined) {
      if (!Array.isArray(d.observations)) { process.stderr.write(`klyro: import failed: "observations" is not an array in ${file}\n`); process.exit(2); }
      if (d.observations.length > 2000) { process.stderr.write(`klyro: import failed: too many observations (${d.observations.length} > 2000) in ${file}\n`); process.exit(2); }
      for (const o of d.observations) {
        if (!o || typeof o !== 'object') { process.stderr.write(`klyro: import failed: malformed observation entry in ${file}\n`); process.exit(2); }
        await store.appendObservation(created.id, o as never);
      }
    }
    process.stdout.write(`imported → ${created.id} (${restored} messages restored)\n`);
  }
  async function sessionFork(id: string): Promise<void> {
    const { getDefaultSessionStore, matchSessionIds } = await import('../persistence/session.js'); const store = getDefaultSessionStore(); const matches = await matchSessionIds(store, id);
    if (matches.length === 0) { process.stderr.write(`session not found: ${id}\n`); process.exit(2); }
    if (matches.length > 1) { process.stderr.write(`ambiguous id "${id}" matches:\n${matches.map((r) => `  ${r.id.slice(0, 8)}  ${r.task.slice(0, 50)}`).join('\n')}\n`); process.exit(2); }
    const full = matches[0]!.id;
    const forked = await store.fork(full);
    const msgs = await store.loadMessages(forked.id);
    process.stdout.write(`forked ${full.slice(0, 8)} → ${forked.id.slice(0, 8)} (${msgs.length} messages carried over)\n`);
  }
  async function sessionDelete(id: string): Promise<void> {
    const { getDefaultSessionStore, matchSessionIds } = await import('../persistence/session.js'); const store = getDefaultSessionStore(); const matches = await matchSessionIds(store, id);
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

  // 9.4 — same namespace as `session`: every subcommand works under both.
  const sessions = program.command('sessions').description('Alias for session (same subcommands)');
  sessions.command('list').description('List persisted sessions').option('--status <s>', 'Filter by status').option('--json', 'Output JSON').action(async (opts: { status?: string; json?: boolean }) => { await sessionList(opts); });
  sessions.command('show <id>').description('Show session transcript and observations').option('--json', 'Output JSON').action(async (id: string, opts: { json?: boolean }) => { await sessionShow(id, opts); });
  sessions.command('resume <id>').description('Resume a persisted session').option('-m, --model <id>', 'Model').option('--max-steps <n>', 'Max steps', (v) => parsePositiveInt('--max-steps', v)).option('--verify-command <cmd>', 'Override verification command').option('--verify', 'Enable verification (default: enabled)').action(async (id: string, opts: { model?: string; maxSteps?: number; verifyCommand?: string; verify?: boolean }) => { await sessionResume(id, opts); });
  sessions.command('export <id> [file]').description('Export session to file (9.4)').action(async (id: string, file?: string) => { await sessionExport(id, file); });
  sessions.command('import <file>').description('Import session from file (restores record + messages + observations)').action(async (file: string) => { await sessionImport(file); });
  sessions.command('fork <id>').description('Fork session with full context (9.4)').action(async (id: string) => { await sessionFork(id); });
  sessions.command('delete <id>').description('Delete a session and its artifacts').action(async (id: string) => { await sessionDelete(id); });
}
