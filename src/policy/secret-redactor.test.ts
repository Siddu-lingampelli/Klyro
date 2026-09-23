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

  it('redacts Bearer with a tab separator (\\s covers \\t)', () => {
    expect(redact('Authorization: Bearer\tabcdef0123456789abcdef0123456789')).toContain('[REDACTED]:bearer');
  });

  it('redacts short generic keys (8+ chars), leaves bare words alone', () => {
    expect(redact('api_key = abcd1234')).toContain('[REDACTED]:api-key');
    expect(redact('token = abcdef12')).toContain('[REDACTED]:secret-generic');
    expect(redact('the api is down')).toBe('the api is down');
    expect(redact('check the token bucket')).toBe('check the token bucket');
  });

  it('passes through clean text', () => {
    expect(redact('hello world')).toBe('hello world');
  });

  it('redacts discord tokens (classic and mfa)', () => {
    const classic = 'M' + 'A'.repeat(23) + '.' + 'B'.repeat(6) + '.' + 'C'.repeat(27);
    expect(redact(`discord ${classic}`)).toContain('[REDACTED]:discord-token');
    const mfa = 'mfa.' + 'x'.repeat(84);
    expect(redact(`discord ${mfa}`)).toContain('[REDACTED]:discord-token');
  });

  it('redacts npm tokens', () => {
    expect(redact('npm_' + 'a'.repeat(36))).toContain('[REDACTED]:npm-token');
  });

  it('redacts sendgrid keys', () => {
    const sg = 'SG.' + 'A'.repeat(22) + '.' + 'B'.repeat(43);
    expect(redact(`sendgrid ${sg}`)).toContain('[REDACTED]:sendgrid-key');
  });

  it('redacts pypi tokens', () => {
    expect(redact('pypi-' + 'aB1_-'.repeat(8))).toContain('[REDACTED]:pypi-token');
  });

  it('leaves hex SHAs untouched', () => {
    const sha = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
    expect(redact(`commit ${sha}`)).toBe(`commit ${sha}`);
  });

  it('still redacts genuine mixed base64 secrets, ignores letter-only runs', () => {
    const secret = 'xQ1+aB2/cD3+eF4/gH5+iJ6/kL7+mN8/oP9+qR0+sT1==';
    expect(redact(`key ${secret}`)).toContain('[REDACTED]:aws-secret-b64');
    const words = 'a'.repeat(48);
    expect(redact(`note ${words}`)).toBe(`note ${words}`);
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
