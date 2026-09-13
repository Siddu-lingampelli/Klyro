/**
 * Custom subagents from markdown files:
 *   `<cwd>/.klyro/agents/*.md` (project) + `~/.klyro/agents/*.md` (global).
 * Project wins on id clash (including overriding a builtin).
 *
 * Frontmatter fields: name (default: filename), description, tools
 * (comma/list — omitted inherits parent tools), model, readonly,
 * canSpawn, maxSteps, maxTokens, maxCost, maxTimeMs, allowedPaths.
 * The markdown body becomes specialist instructions (`prompt`) prepended
 * to the delegated task. Unknown tool names are NOT rejected here —
 * `resolveCapabilities` drops them with reasons at spawn time.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseFrontmatter, parseList, parseBool, parseInt_ } from '../cli/slash/custom.js';
import type { AgentDefinition } from './orchestrator.js';

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function readAgentFile(file: string, source: 'project' | 'global'): AgentDefinition | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(raw);
  const fallback = path.basename(file, path.extname(file));
  const id = (data['name'] || fallback).toLowerCase();
  if (!AGENT_ID_RE.test(id)) return null;
  const description = data['description'] || `Custom agent ${id}`;
  const def: AgentDefinition = { id, description };
  const tools = parseList(data['tools']);
  if (tools.length > 0) def.allowedTools = tools;
  if (data['model']) def.model = data['model'];
  if (data['readonly'] !== undefined && data['readonly'] !== '') def.readonly = parseBool(data['readonly'], false);
  if (data['canSpawn'] !== undefined && data['canSpawn'] !== '') def.canSpawn = parseBool(data['canSpawn'], false);
  const maxSteps = parseInt_(data['maxsteps']);
  if (maxSteps !== undefined) def.maxSteps = maxSteps;
  const maxTokens = parseInt_(data['maxtokens']);
  if (maxTokens !== undefined) def.maxTokens = maxTokens;
  const maxCost = data['maxcost'] !== undefined && data['maxcost'] !== '' ? Number(data['maxcost']) : undefined;
  if (maxCost !== undefined && Number.isFinite(maxCost) && maxCost > 0) def.maxCost = maxCost;
  const maxTimeMs = parseInt_(data['maxtimems']);
  if (maxTimeMs !== undefined) def.maxTimeMs = maxTimeMs;
  const paths = parseList(data['allowedpaths']);
  if (paths.length > 0) def.allowedPaths = paths;
  const prompt = body.trim();
  if (prompt) def.prompt = prompt;
  def.source = source;
  return def;
}

function listAgentFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/** Load custom agents: global first, project wins on id clash. Never throws. */
export function loadCustomAgents(cwd: string): AgentDefinition[] {
  const byId = new Map<string, AgentDefinition>();
  try {
    const home = os.homedir() || process.cwd();
    for (const f of listAgentFiles(path.join(home, '.klyro', 'agents'))) {
      const d = readAgentFile(f, 'global');
      if (d) byId.set(d.id, d);
    }
    for (const f of listAgentFiles(path.join(cwd, '.klyro', 'agents'))) {
      const d = readAgentFile(f, 'project');
      if (d) byId.set(d.id, d);
    }
  } catch {
    return [...byId.values()];
  }
  return [...byId.values()];
}
