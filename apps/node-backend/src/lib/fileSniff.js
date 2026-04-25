/**
 * File magic-byte sniff — content-based MIME detection for upload validation.
 *
 * The client-supplied MIME and extension are both attacker-controlled. To
 * prevent renamed-payload bypasses (e.g. PNG renamed evil.pdf, or HTML
 * uploaded as image/png), inspect the actual byte signature.
 *
 * Coverage matches the formats accepted by attachmentService:
 *   - image/png, image/jpeg, image/gif, image/webp
 *   - application/pdf
 *
 * sniffMime() returns the canonical MIME type or null when no signature
 * matches. Buffers shorter than the minimum signature length return null.
 */

const MIME_PNG = 'image/png';
const MIME_JPEG = 'image/jpeg';
const MIME_GIF = 'image/gif';
const MIME_WEBP = 'image/webp';
const MIME_PDF = 'application/pdf';

const SIG_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SIG_JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const SIG_GIF87 = Buffer.from('GIF87a');
const SIG_GIF89 = Buffer.from('GIF89a');
const SIG_RIFF = Buffer.from('RIFF');
const SIG_WEBP = Buffer.from('WEBP');
const SIG_PDF = Buffer.from('%PDF-');

export function sniffMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;

  if (buffer.length >= SIG_PNG.length && buffer.subarray(0, SIG_PNG.length).equals(SIG_PNG)) {
    return MIME_PNG;
  }
  if (buffer.length >= SIG_JPEG.length && buffer.subarray(0, SIG_JPEG.length).equals(SIG_JPEG)) {
    return MIME_JPEG;
  }
  if (
    buffer.length >= SIG_GIF87.length
    && (buffer.subarray(0, SIG_GIF87.length).equals(SIG_GIF87)
      || buffer.subarray(0, SIG_GIF89.length).equals(SIG_GIF89))
  ) {
    return MIME_GIF;
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).equals(SIG_RIFF)
    && buffer.subarray(8, 12).equals(SIG_WEBP)
  ) {
    return MIME_WEBP;
  }
  if (buffer.length >= SIG_PDF.length && buffer.subarray(0, SIG_PDF.length).equals(SIG_PDF)) {
    return MIME_PDF;
  }
  return null;
}

const EXTENSION_FAMILY = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

export function extensionMime(ext) {
  if (!ext) return null;
  return EXTENSION_FAMILY[ext.toLowerCase()] || null;
}
