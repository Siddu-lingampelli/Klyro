import { describe, it, expect } from 'vitest';
import { redact, createRedactor } from './secret-redactor.js';

describe('redact', () => {
  it('redacts AWS access keys', () => {
    expect(redact('aws_key=AKIAABCDEFGHIJKLMNOP')).toContain('[REDACTED]:aws-key');
  });

  it('redacts PEM blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nABCDEF\n-----END RSA PRIVATE KEY-----';
    expect(redact(pem)).toContain('[REDACTED]:pem-block');
    expect(redact(pem)).not.toContain('ABCDEF');
  });

  it('redacts GitHub tokens', () => {
    expect(redact('token: ghp_abcdef0123456789abcdef0123456789abcd')).toContain('[REDACTED]:github-token');
  });

  it('redacts bearer tokens', () => {
    expect(redact('Authorization: Bearer abcdef0123456789abcdef0123456789')).toContain('[REDACTED]:bearer');
  });

  it('passes through clean text', () => {
    expect(redact('hello world')).toBe('hello world');
  });
});

describe('createRedactor', () => {
  it('redacts across chunk boundaries', async () => {
    const r = createRedactor();
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.write('AKIAABCDEFGHIJKLMN');
    r.write('NOP and other text');
    r.end();
    const out = Buffer.concat(chunks).toString('utf-8');
    expect(out).toContain('[REDACTED]:aws-key');
    expect(out).not.toContain('AKIAABCDEFGHIJKLMNNOP');
  });
});
