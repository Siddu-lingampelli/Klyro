import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchUrlDenialReason, stripHtmlToText, mappedIPv4 } from './web-fetch.js';
import { parseDuckDuckGo } from './web-search.js';
import { builtinRegistry } from '../registry.js';
import { PolicyEngine, DEFAULT_POLICY_CONFIG } from '../../policy/engine.js';

const ENV: Record<string, string | undefined> = {};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchUrlDenialReason', () => {
  it('allows https', () => {
    expect(fetchUrlDenialReason('https://example.com/docs', ENV)).toBeNull();
  });

  it('rejects non-http schemes', () => {
    expect(fetchUrlDenialReason('file:///etc/passwd', ENV)).toMatch(/non-http/);
  });

  it('rejects invalid URLs', () => {
    expect(fetchUrlDenialReason('not a url', ENV)).toMatch(/invalid URL/);
  });

  it('rejects plaintext http for public hosts', () => {
    expect(fetchUrlDenialReason('http://example.com/', ENV)).toMatch(/plaintext http/);
  });

  it('allows http loopback', () => {
    expect(fetchUrlDenialReason('http://localhost:11434/', ENV)).toBeNull();
    expect(fetchUrlDenialReason('http://127.0.0.1:8080/x', ENV)).toBeNull();
    // IPv6 loopback arrives bracketed from WHATWG URL — still local.
    expect(fetchUrlDenialReason('http://[::1]:11434/', ENV)).toBeNull();
  });

  it('blocks cloud metadata endpoints on any scheme (SSRF)', () => {
    expect(fetchUrlDenialReason('http://169.254.169.254/latest/meta-data/', ENV)).toMatch(/metadata/);
    expect(fetchUrlDenialReason('https://169.254.169.254/', ENV)).toMatch(/metadata/);
    expect(fetchUrlDenialReason('http://169.254.169.253/', ENV)).toMatch(/metadata/);
    // IPv4-mapped IPv6 reaches the same IMDS address (URL hexifies it).
    expect(fetchUrlDenialReason('http://[::ffff:169.254.169.254]/latest/meta-data/', ENV)).toMatch(/metadata/);
  });

  it('refuses unspecified destination addresses', () => {
    expect(fetchUrlDenialReason('http://0.0.0.0/', ENV)).toMatch(/unspecified/);
    expect(fetchUrlDenialReason('https://0.0.0.0:8080/x', ENV)).toMatch(/unspecified/);
    expect(fetchUrlDenialReason('http://[::]/', ENV)).toMatch(/unspecified/);
    expect(fetchUrlDenialReason('https://[::]/', ENV)).toMatch(/unspecified/);
    expect(fetchUrlDenialReason('http://[0:0:0:0:0:0:0:0]/', ENV)).toMatch(/unspecified/);
    expect(fetchUrlDenialReason('http://[::ffff:0.0.0.0]/', ENV)).toMatch(/unspecified/);
  });

  it('canonicalizes IPv4-mapped IPv6 to a dotted quad', () => {
    expect(mappedIPv4('::ffff:a9fe:a9fe')).toBe('169.254.169.254');
    expect(mappedIPv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(mappedIPv4('::ffff:169.254.169.254')).toBe('169.254.169.254');
    expect(mappedIPv4('example.com')).toBeNull();
    expect(mappedIPv4('::1')).toBeNull();
  });

  it('honors KLYRO_WEB_DENYLIST and ALLOWLIST', () => {
    expect(
      fetchUrlDenialReason('https://evil.example.com/', { KLYRO_WEB_DENYLIST: 'example.com' }),
    ).toMatch(/DENYLIST/);
    expect(fetchUrlDenialReason('https://other.com/', { KLYRO_WEB_ALLOWLIST: 'example.com' })).toMatch(
      /ALLOWLIST/,
    );
    expect(fetchUrlDenialReason('https://docs.example.com/', { KLYRO_WEB_ALLOWLIST: 'example.com' })).toBeNull();
  });
});

describe('stripHtmlToText', () => {
  it('strips scripts/styles and extracts title', () => {
    const { title, text } = stripHtmlToText(
      '<html><head><title>Hi</title><style>.x{}</style></head><body><script>evil()</script><p>Hello <b>world</b></p></body></html>',
    );
    expect(title).toBe('Hi');
    expect(text).toContain('Hello world');
    expect(text).not.toContain('evil()');
  });

  it('decodes entities', () => {
    expect(stripHtmlToText('<p>a &amp; b &#65;</p>').text).toBe('a & b A');
  });
});

describe('parseDuckDuckGo', () => {
  it('flattens abstract + results + nested topics with cap', () => {
    const out = parseDuckDuckGo(
      {
        AbstractText: 'abs',
        AbstractURL: 'https://a.example/',
        Results: [{ FirstURL: 'https://b.example/', Text: 'b' }],
        RelatedTopics: [{ FirstURL: 'https://c.example/', Text: 'c' }, { Topics: [{ FirstURL: 'https://d.example/' }] }],
      },
      3,
    );
    expect(out.map((r) => r.url)).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);
  });

  it('handles empty payloads', () => {
    expect(parseDuckDuckGo({}, 5)).toEqual([]);
  });
});

describe('web tools in registry + policy', () => {
  it('registers web_fetch and web_search with network permission', () => {
    const r = builtinRegistry();
    expect(r.get('web_fetch')?.permission).toBe('network');
    expect(r.get('web_search')?.permission).toBe('network');
  });

  it('network tools ask interactively and deny headless without an allow rule', async () => {
    const e = new PolicyEngine([], DEFAULT_POLICY_CONFIG);
    const cwd = process.cwd();
    const ask = await e.evaluate({ name: 'web_fetch', input: {}, permission: 'network' }, { cwd, nonInteractive: false });
    expect(ask.action).toBe('ask');
    const deny = await e.evaluate({ name: 'web_fetch', input: {}, permission: 'network' }, { cwd, nonInteractive: true });
    expect(deny.action).toBe('deny');
  });

  it('web_fetch refuses non-textual content without network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([0x89, 0x50]).buffer, { status: 200, headers: { 'content-type': 'image/png' } })),
    );
    const r = builtinRegistry();
    const result = await r.execute('web_fetch', { url: 'https://example.com/x.png' }, { cwd: process.cwd(), env: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNSUPPORTED_TYPE');
  });

  it('web_fetch denies a redirect bounce to plaintext http', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://example.com/' } })),
    );
    const r = builtinRegistry();
    const result = await r.execute('web_fetch', { url: 'https://example.com/' }, { cwd: process.cwd(), env: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FETCH_DENIED');
  });

  it('web_fetch follows a same-policy redirect', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        calls.push(u);
        if (u === 'https://example.com/') {
          return new Response(null, { status: 301, headers: { location: '/docs' } });
        }
        return new Response('<p>Hi</p>', { status: 200, headers: { 'content-type': 'text/html' } });
      }),
    );
    const r = builtinRegistry();
    const result = await r.execute('web_fetch', { url: 'https://example.com/' }, { cwd: process.cwd(), env: {} });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['https://example.com/', 'https://example.com/docs']);
  });

  it('web_fetch extracts text from stubbed HTML', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><head><title>T</title></head><body><p>Hello</p></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    const r = builtinRegistry();
    const result = await r.execute('web_fetch', { url: 'https://example.com/' }, { cwd: process.cwd(), env: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.value as { text: string; title?: string; untrusted: boolean };
      expect(v.text).toContain('Hello');
      expect(v.title).toBe('T');
      expect(v.untrusted).toBe(true);
    }
  });

  it('web_search parses stubbed backend JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ AbstractText: 'abs', AbstractURL: 'https://a.example/' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const r = builtinRegistry();
    const result = await r.execute('web_search', { query: 'klyro' }, { cwd: process.cwd(), env: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.value as { results: Array<{ url: string }>; untrusted: boolean };
      expect(v.results[0]?.url).toBe('https://a.example/');
      expect(v.untrusted).toBe(true);
    }
  });
});
