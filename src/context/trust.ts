/**
 * P0.3 — context-file trust gate (r-11-17.md §5.1).
 *
 * Closes the shared HIGH flaw: `KLYRO.md` / `AGENTS.md` are auto-loaded into
 * the prompt, so a malicious commit can smuggle instructions that read as
 * authenticated system guidance. Every auto-loaded file is hashed; the first
 * sighting (or any change) requires explicit approval before the content may
 * enter context. Decisions persist in `~/.klyro/context-trust.json`.
 *
 * Headless runs approve nothing (secure default): untrusted files are
 * excluded and the exclusion is visible on the event bus.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { KlyroEvent } from '../events/catalog.js';
import { loadKlyroMdFiles, type KlyroMdFile } from './klyro-md.js';

export interface TrustRecord {
  sha256: string;
  trustedAt: number;
}

export type TrustStore = Record<string, TrustRecord>;

export type TrustReason = 'unknown' | 'changed';

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** Pure evaluation: split files into trusted vs needs-approval. */
export function evaluateTrust(
  stored: TrustStore,
  files: KlyroMdFile[],
): { trusted: KlyroMdFile[]; untrusted: { file: KlyroMdFile; reason: TrustReason }[] } {
  const trusted: KlyroMdFile[] = [];
  const untrusted: { file: KlyroMdFile; reason: TrustReason }[] = [];
  for (const f of files) {
    const rec = stored[f.path];
    if (!rec) {
      untrusted.push({ file: f, reason: 'unknown' });
    } else if (rec.sha256 !== hashContent(f.content)) {
      untrusted.push({ file: f, reason: 'changed' });
    } else {
      trusted.push(f);
    }
  }
  return { trusted, untrusted };
}

export function defaultTrustStorePath(): string {
  return path.join(os.homedir() || process.cwd(), '.klyro', 'context-trust.json');
}

export class ContextTrust {
  private store: TrustStore = {};

  constructor(private readonly storePath: string = defaultTrustStorePath()) {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.storePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.store = parsed as TrustStore;
      }
    } catch {
      this.store = {};
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), 'utf-8');
    } catch {
      /* best-effort — trust stays in memory for the session */
    }
  }

  check(files: KlyroMdFile[]): ReturnType<typeof evaluateTrust> {
    return evaluateTrust(this.store, files);
  }

  /** Record approval for the file's current content. */
  approve(file: KlyroMdFile): void {
    this.store[file.path] = { sha256: hashContent(file.content), trustedAt: Date.now() };
    this.save();
  }

  isTrusted(file: KlyroMdFile): boolean {
    const rec = this.store[file.path];
    return !!rec && rec.sha256 === hashContent(file.content);
  }
}

export interface TrustedLoadOpts {
  trust: ContextTrust;
  /** Return true to include an untrusted file (and persist the approval). */
  approve: (file: KlyroMdFile, reason: TrustReason) => Promise<boolean>;
  sessionId?: string;
  emit?: (ev: KlyroEvent) => void;
}

/**
 * Load KLYRO.md hierarchy with the trust gate applied. Untrusted files are
 * offered to `approve`; declined files are excluded from the returned text.
 * Every gate decision emits `context.trust_prompt` on the bus.
 */
export async function loadTrustedKlyroMd(cwd: string, opts: TrustedLoadOpts): Promise<string> {
  const sessionId = opts.sessionId ?? 'ephemeral';
  const files = await loadKlyroMdFiles(cwd);
  const { trusted, untrusted } = opts.trust.check(files);
  const kept: KlyroMdFile[] = [...trusted];
  for (const { file, reason } of untrusted) {
    let ok = false;
    try {
      ok = await opts.approve(file, reason);
    } catch {
      ok = false;
    }
    opts.emit?.({ type: 'context.trust_prompt', ts: Date.now(), sessionId, path: file.path, reason, trusted: ok });
    if (ok) {
      opts.trust.approve(file);
      kept.push(file);
    }
  }
  // Preserve loader order.
  const order = new Map(files.map((f, i) => [f.path, i] as const));
  kept.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
  return kept.map((f) => `# ${f.path}\n${f.content}`).join('\n\n---\n\n');
}
