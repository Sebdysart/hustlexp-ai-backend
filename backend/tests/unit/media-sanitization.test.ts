import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  MAX_MEDIA_UPLOAD_BYTES,
  MediaSanitizationError,
  sanitizeImageBytes,
  verifySanitizedImageBytes,
} from '../../src/services/MediaSanitizationService';

const PRIVATE_MARKER = 'GPS=47.6062,-122.3321;device=iPhone';

async function jpegWithPrivateXmp(): Promise<Buffer> {
  return sharp({
    create: { width: 3, height: 2, channels: 3, background: '#ff4f00' },
  })
    .jpeg({ quality: 92 })
    .withXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/">${PRIVATE_MARKER}</x:xmpmeta>`)
    .toBuffer();
}

describe('server media sanitization', () => {
  it('decodes and re-encodes pixels while removing XMP, GPS, and device markers', async () => {
    const source = await jpegWithPrivateXmp();
    expect(source.includes(Buffer.from(PRIVATE_MARKER))).toBe(true);

    const output = await sanitizeImageBytes(source, 'image/jpeg');

    expect(output.sourceMetadataDetected).toBe(true);
    expect(output.data.includes(Buffer.from(PRIVATE_MARKER))).toBe(false);
    expect(output.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect([output.width, output.height]).toEqual([3, 2]);
    expect(output.contentType).toBe('image/jpeg');
    const metadata = await sharp(output.data).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
  });

  it.each([
    ['image/png', 'png'],
    ['image/webp', 'webp'],
  ] as const)('supports a valid %s image', async (contentType, format) => {
    const source = await sharp({
      create: { width: 4, height: 3, channels: 4, background: '#7c3aed' },
    })[format]().toBuffer();
    const output = await sanitizeImageBytes(source, contentType);
    expect(output.contentType).toBe(contentType);
    expect([output.width, output.height]).toEqual([4, 3]);
  });

  it('rejects MIME spoofing before returning canonical bytes', async () => {
    const source = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#000000' },
    }).png().toBuffer();
    await expect(sanitizeImageBytes(source, 'image/jpeg')).rejects.toMatchObject({
      code: 'MEDIA_TYPE_MISMATCH',
    });
  });

  it('rejects unsupported HEIC rather than claiming it was stripped', async () => {
    await expect(sanitizeImageBytes(Buffer.from('not-heic'), 'image/heic')).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  });

  it('rejects malformed and oversized input fail-closed', async () => {
    await expect(sanitizeImageBytes(Buffer.from('not-an-image'), 'image/jpeg')).rejects.toBeInstanceOf(
      MediaSanitizationError,
    );
    await expect(
      sanitizeImageBytes(Buffer.alloc(MAX_MEDIA_UPLOAD_BYTES + 1), 'image/jpeg'),
    ).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
  });

  it('verifies canonical bytes without trusting metadata-bearing source bytes', async () => {
    const source = await jpegWithPrivateXmp();
    const canonical = await sanitizeImageBytes(source, 'image/jpeg');

    await expect(verifySanitizedImageBytes(canonical.data, 'image/jpeg')).resolves.toEqual({
      width: 3,
      height: 2,
    });
    await expect(verifySanitizedImageBytes(source, 'image/jpeg')).rejects.toMatchObject({
      code: 'METADATA_STRIP_FAILED',
    });
  });
});
