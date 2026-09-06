/**
 * 2.3 — Layered system prompt (stable first): identity → environment → global instructions
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

function getBranch(cwd: string): string {
  try {
    const r = spawnSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf-8', timeout: 800, windowsHide: true });
    if (r.status === 0) return r.stdout.trim();
  } catch { /* ignore */ }
  return '';
}

export function buildSystemPrompt(opts: {
  cwd: string;
  model: string;
  extraSystem?: string;
  appendSystem?: string;
  thinkingEnabled?: boolean;
}): string {
  const identity = `You are Klyro, an autonomous coding harness. You solve the user's task by calling tools in a loop. Prefer the smallest change that solves the task. When you have finished, produce a short final text answer (no tool calls). Do not invent file paths. Do not call tools outside the working directory.`;

  const env = [
    `OS: ${os.type()} ${os.release()} ${os.arch()}`,
    `Shell: ${process.env.SHELL ?? process.env.COMSPEC ?? 'unknown'}`,
    `CWD: ${opts.cwd}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Branch: ${getBranch(opts.cwd) || '(no git)'}`,
    `Model: ${opts.model}`,
  ].join('\n');

  const global = `Global instructions: Be concise, verify after edits, and never say "Done" without running verification.`;

  const parts = [identity, `Environment:\n${env}`, global];
  if (opts.extraSystem) parts.splice(1, 0, opts.extraSystem);
  if (opts.appendSystem) parts.push(opts.appendSystem);
  if (opts.thinkingEnabled) parts.push('Thinking: enabled — use internal reasoning before tool calls.');

  return parts.join('\n\n');
}

export function parseImageInput(text: string): { text: string; images: string[] } {
  // Handle @img.png, drag-drop path, clipboard stub
  const images: string[] = [];
  const imgRe = /@([^\s]+\.(png|jpg|jpeg|gif|webp))/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(text))) {
    if (m[1]) images.push(m[1]);
  }
  // Remove @img refs from text for now (real impl would attach as image block)
  const clean = text.replace(imgRe, '').trim();
  return { text: clean, images };
}
