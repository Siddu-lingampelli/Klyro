/**
 * Secret redaction — strip common credential shapes from tool outputs
 * before they enter the transcript.
 *
 * Pattern coverage: AWS access keys, PEM blocks, GitHub tokens, Slack tokens,
 * generic bearer/JWT, and high-entropy hex strings (best-effort).
 *
 * Streaming: we expose `createRedactor()` returning a Transform so large
 * outputs don't have to buffer in memory.
 */

import { Transform } from 'node:stream';

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'aws-key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'aws-secret', re: /(?:aws_secret_access_key|secret)\s*[:=]\s*[A-Za-z0-9/+=]{40}/gi },
  { name: 'aws-secret-b64', re: /(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+=]*[+/=])[A-Za-z0-9/+=]{40,}={0,2}(?![A-Za-z0-9/+=])/g, },
  { name: 'pem-block', re: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g },
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,255}/g },
  { name: 'slack-token', re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'bearer', re: /Bearer\s+[A-Za-z0-9._\-+/=]{16,}/gi },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // Generic provider keys — must be redacted even if not prefixed Bearer
  { name: 'openai-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'api-key', re: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}['"]?/gi },
  { name: 'password', re: /(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{4,}['"]?/gi },
  { name: 'secret-generic', re: /(?:secret|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-+/=]{16,}['"]?/gi },
];

const REPLACEMENT = '[REDACTED]';

/** Redact a single string (or Buffer). */
export function redact(input: string | Buffer): string {
  const s = typeof input === 'string' ? input : input.toString('utf-8');
  let out = s;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, `${REPLACEMENT}:${name}`);
  }
  return out;
}

/**
 * Streaming transform that redacts as bytes flow through. Useful for
 * piping shell stdout/stderr into the transcript without buffering the
 * full output in memory.
 */
export function createRedactor(): Transform {
  let buf = '';
  return new Transform({
    transform(chunk: Buffer | string, _enc, cb) {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      // Keep last 1 KiB un-flushed in case a multi-byte pattern straddles
      // chunk boundaries.
      const flushEnd = Math.max(0, buf.length - 1024);
      const flush = buf.slice(0, flushEnd);
      buf = buf.slice(flushEnd);
      cb(null, redact(flush));
    },
    flush(cb) {
      cb(null, redact(buf));
    },
  });
}
