/**
 * SSRF guard tests — covers IP-range classification, scheme enforcement, and
 * DNS-resolution-based blocking for user-controlled outbound URLs.
 */
import { describe, it, expect } from 'vitest';
import {
  isBlockedIpv4,
  isBlockedIpv6,
  isBlockedAddress,
  assertPublicHttpUrl,
  BlockedUrlError,
} from '../src/lib/urlSafety.js';

describe('isBlockedIpv4', () => {
  it('blocks loopback, private, link-local, CGNAT and unspecified ranges', () => {
    for (const ip of [
      '127.0.0.1', '127.5.5.5',
      '10.0.0.1', '10.255.255.255',
      '172.16.0.1', '172.31.255.255',
      '192.168.0.1', '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', '100.127.255.255', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isBlockedIpv4(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1']) {
      expect(isBlockedIpv4(ip), ip).toBe(false);
    }
  });

  it('fails closed on malformed input', () => {
    for (const ip of ['', 'not-an-ip', '999.1.1.1', '10.0.0']) {
      expect(isBlockedIpv4(ip), ip).toBe(true);
    }
  });
});

describe('isBlockedIpv6', () => {
  it('blocks loopback, unspecified, ULA, link-local and mapped-private', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isBlockedIpv6(ip), ip).toBe(true);
    }
  });

  it('allows public v6 and mapped-public', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
      expect(isBlockedIpv6(ip), ip).toBe(false);
    }
  });
});

describe('isBlockedAddress', () => {
  it('routes v4 / v6 / non-IP correctly', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('example.com')).toBe(true); // not an IP → fail closed
  });
});

describe('assertPublicHttpUrl', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  it('rejects non-http(s) schemes', async () => {
    for (const u of ['file:///etc/passwd', 'gopher://x', 'data:text/plain,hi', 'ftp://host/x']) {
      await expect(assertPublicHttpUrl(u, { lookup: publicLookup }), u).rejects.toBeInstanceOf(BlockedUrlError);
    }
  });

  it('rejects invalid URLs', async () => {
    await expect(assertPublicHttpUrl('http://', { lookup: publicLookup })).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertPublicHttpUrl('not a url', { lookup: publicLookup })).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('rejects private IP-literal hosts without needing DNS', async () => {
    for (const u of [
      'http://127.0.0.1/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5:8080/',
      'http://[::1]/',
      'https://192.168.1.1/admin',
    ]) {
      await expect(assertPublicHttpUrl(u, { resolveDns: false }), u).rejects.toBeInstanceOf(BlockedUrlError);
    }
  });

  it('allows public IP literals', async () => {
    const url = await assertPublicHttpUrl('https://8.8.8.8/data', { resolveDns: false });
    expect(url.hostname).toBe('8.8.8.8');
  });

  it('blocks a DNS name that resolves to a private address (rebinding)', async () => {
    const evilLookup = async () => [{ address: '127.0.0.1', family: 4 }];
    await expect(
      assertPublicHttpUrl('https://evil.example.com/x', { lookup: evilLookup }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('blocks when ANY resolved address is private (mixed result set)', async () => {
    const mixedLookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ];
    await expect(
      assertPublicHttpUrl('https://mixed.example.com/x', { lookup: mixedLookup }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('allows a DNS name that resolves only to public addresses', async () => {
    const url = await assertPublicHttpUrl('https://api.example.com/price', { lookup: publicLookup });
    expect(url.hostname).toBe('api.example.com');
  });

  it('rejects when DNS resolution fails or returns nothing', async () => {
    await expect(
      assertPublicHttpUrl('https://nxdomain.example/x', { lookup: async () => { throw new Error('ENOTFOUND'); } }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(
      assertPublicHttpUrl('https://empty.example/x', { lookup: async () => [] }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('skips DNS when resolveDns=false (boundary mode allows public hostnames syntactically)', async () => {
    const url = await assertPublicHttpUrl('https://api.example.com/price', { resolveDns: false });
    expect(url.hostname).toBe('api.example.com');
  });
});
