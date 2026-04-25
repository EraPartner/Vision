import { describe, it, expect } from 'vitest';
import { sniffMime, extensionMime } from '../src/lib/fileSniff.js';

const buf = (...bytes) => Buffer.from(bytes);

describe('sniffMime', () => {
  it('detects PNG', () => {
    expect(sniffMime(buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00))).toBe('image/png');
  });

  it('detects JPEG', () => {
    expect(sniffMime(buf(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
  });

  it('detects GIF87a and GIF89a', () => {
    expect(sniffMime(Buffer.from('GIF87a....'))).toBe('image/gif');
    expect(sniffMime(Buffer.from('GIF89a....'))).toBe('image/gif');
  });

  it('detects WEBP (RIFF + WEBP at offset 8)', () => {
    const b = Buffer.alloc(16, 0);
    Buffer.from('RIFF').copy(b, 0);
    Buffer.from('WEBP').copy(b, 8);
    expect(sniffMime(b)).toBe('image/webp');
  });

  it('detects PDF', () => {
    expect(sniffMime(Buffer.from('%PDF-1.7\n%abc'))).toBe('application/pdf');
  });

  it('returns null for garbage bytes', () => {
    expect(sniffMime(buf(0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07))).toBeNull();
  });

  it('returns null for HTML masquerading as image', () => {
    expect(sniffMime(Buffer.from('<html><body>'))).toBeNull();
  });

  it('returns null for too-short buffers', () => {
    expect(sniffMime(buf(0x89))).toBeNull();
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for non-buffer input', () => {
    expect(sniffMime(null)).toBeNull();
    expect(sniffMime('not a buffer')).toBeNull();
  });

  it('does not detect RIFF without WEBP marker', () => {
    const b = Buffer.alloc(16, 0);
    Buffer.from('RIFF').copy(b, 0);
    Buffer.from('WAVE').copy(b, 8);
    expect(sniffMime(b)).toBeNull();
  });
});

describe('extensionMime', () => {
  it('maps known extensions', () => {
    expect(extensionMime('.png')).toBe('image/png');
    expect(extensionMime('.JPG')).toBe('image/jpeg');
    expect(extensionMime('.jpeg')).toBe('image/jpeg');
    expect(extensionMime('.pdf')).toBe('application/pdf');
  });

  it('returns null for unknown', () => {
    expect(extensionMime('.exe')).toBeNull();
    expect(extensionMime('')).toBeNull();
    expect(extensionMime(null)).toBeNull();
  });
});
