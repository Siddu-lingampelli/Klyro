/**
 * Interactive REPL. Reads prompts from stdin one line at a time.
 *
 * Conversation history lives in memory only; each new prompt is sent with the
 * full history so the model can refer back to earlier turns.
 *
 * Type ':quit' (or Ctrl-C / Ctrl-D) to exit.
 */

import * as readline from 'node:readline/promises';
import { stdin, exit } from 'node:process';
import { streamToStdout, readBoundedText } from './chat.js';
import { resolveProvider, providerHelp } from './providers.js';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/** Cap conversation history so we don't blow the model's context window. */
const MAX_HISTORY_TURNS = 40;
/** Approximate char budget for the user side of history. */
const MAX_HISTORY_CHARS = 80_000;

export async function repl(system: string): Promise<void> {
  const provider = await resolveProvider();
  if (!provider) {
    console.error('klyro: no provider available.');
    console.error('  Set KLYRO_BASE_URL and KLYRO_API_KEY, or run a local server (Ollama, LM Studio, vLLM).');
    console.error('  Examples:');
    console.error('    set KLYRO_BASE_URL=https://api.openai.com/v1');
    console.error('    set KLYRO_API_KEY=sk-...');
    console.error('    ollama serve   # then KLYRO_BASE_URL=http://localhost:11434/v1 KLYRO_MODEL=llama3.2');
    exit(2);
  }
  const { baseURL, apiKey, model, source } = provider;

  const history: Turn[] = [];
  // Adapt readline to the environment. On a TTY we let readline manage the
  // prompt and echo so the user sees their typing; on a pipe we suppress both
  // because the consumer is a script, not a human.
  const isTTY = Boolean(stdin.isTTY);
  const rl = readline.createInterface({
    input: stdin,
    output: isTTY ? process.stdout : undefined,
    terminal: isTTY,
  });

  // Ctrl-C: when readline is in TTY mode it intercepts SIGINT and emits a
  // 'SIGINT' event on the interface. Wire it to a clean exit so the user gets
  // exit code 130 (the conventional 128+SIGINT(2)) instead of a crash.
  rl.on('SIGINT', () => {
    process.stdout.write('\n');
    rl.close();
    exit(130);
  });

  if (isTTY) console.log(`klyro REPL — type :quit to exit, :clear to reset history  ${providerHelp(provider)}`);
  try {
    while (true) {
      // In TTY mode, readline handles the prompt and echoes the user's typing.
      // In non-TTY mode, we write the prompt ourselves.
      if (!isTTY) process.stdout.write('> ');
      let line: string;
      try {
        // Pass the prompt only when readline is in charge (TTY). In non-TTY
        // mode the prompt is suppressed (output: undefined) so passing '' is
        // equivalent and avoids doubling.
        line = await rl.question(isTTY ? '> ' : '');
      } catch (err) {
        // EOF on stdin (Ctrl-D) or close — exit cleanly.
        break;
      }
      if (!line) break; // empty line on EOF
      const prompt = line.trim();
      if (!prompt) continue;
      if (prompt === ':quit' || prompt === ':exit') break;
      if (prompt === ':clear') {
        history.length = 0;
        if (isTTY) console.log('(history cleared)');
        continue;
      }
      history.push({ role: 'user', content: prompt });
      trimHistory(history);

      const reply = await ask(baseURL, apiKey, model, system, history);
      history.push({ role: 'assistant', content: reply });
      // streamToStdout already ends with a newline; no extra needed.
    }
  } finally {
    rl.close();
  }
}

/** Drop oldest turns to stay under the size cap. */
function trimHistory(history: Turn[]): void {
  while (history.length > MAX_HISTORY_TURNS) history.shift();
  let total = 0;
  for (const t of history) total += t.content.length;
  while (total > MAX_HISTORY_CHARS && history.length > 2) {
    const head = history[0];
    if (!head) break;
    total -= head.content.length;
    history.shift();
  }
}

/** Send the full history, stream the reply, return the assistant text. */
async function ask(
  baseURL: string,
  apiKey: string,
  model: string,
  system: string,
  history: Turn[],
): Promise<string> {
  const ac = new AbortController();
  const timeoutMs = Number(process.env.KLYRO_TIMEOUT_MS) || 60_000;
  const t = setTimeout(() => ac.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);

  let res: Response;
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // Only attach Authorization when a key is configured. Local servers
    // (Ollama, LM Studio) accept requests without auth.
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    res = await fetch(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        // System message once, at the head of the messages array.
        messages: [{ role: 'system', content: system }, ...history],
        stream: true,
      }),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(t);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nklyro: request failed: ${msg}`);
    return '';
  }
  clearTimeout(t);

  if (!res.ok) {
    const text = await readBoundedText(res.body, 4000);
    console.error(`\nklyro: HTTP ${res.status} ${res.statusText}\n${text}`);
    return '';
  }
  if (!res.body) {
    console.error('\nklyro: no response body');
    return '';
  }

  // Use the shared streamToStdout from chat.ts. Capture what we wrote so we
  // can return it for the conversation history.
  const collected: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    if (typeof chunk === 'string') collected.push(chunk);
    return origWrite(chunk);
  };
  try {
    await streamToStdout(res.body, ac.signal);
  } catch (err) {
    if (!ac.signal.aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nklyro: stream error: ${msg}`);
    }
  } finally {
    (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
  }
  return collected.join('');
}
