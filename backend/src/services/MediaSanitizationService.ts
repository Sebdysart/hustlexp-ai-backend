import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';

export const SUPPORTED_SANITIZED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type SanitizedImageContentType = typeof SUPPORTED_SANITIZED_IMAGE_TYPES[number];

export const MAX_MEDIA_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_MEDIA_UPLOAD_PIXELS = 40_000_000;

const CONTENT_TYPE_FORMAT: Record<SanitizedImageContentType, 'jpeg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const CONTENT_TYPE_EXTENSION: Record<SanitizedImageContentType, 'jpg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export class MediaSanitizationError extends Error {
  constructor(
    readonly code:
      | 'EMPTY_MEDIA'
      | 'MEDIA_TOO_LARGE'
      | 'UNSUPPORTED_MEDIA_TYPE'
      | 'MEDIA_TYPE_MISMATCH'
      | 'INVALID_IMAGE'
      | 'ANIMATED_IMAGE_UNSUPPORTED'
      | 'METADATA_STRIP_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'MediaSanitizationError';
  }
}

function hasEmbeddedMetadata(metadata: Metadata): boolean {
  return Boolean(
    metadata.exif
    || metadata.icc
    || metadata.iptc
    || metadata.xmp
    || (metadata.comments?.length ?? 0) > 0,
  );
}

function assertSourceMetadata(
  metadata: Metadata,
  declaredContentType: SanitizedImageContentType,
): void {
  if (!metadata.width || !metadata.height || metadata.width <= 0 || metadata.height <= 0) {
    throw new MediaSanitizationError('INVALID_IMAGE', 'Image dimensions could not be verified.');
  }
  if (metadata.width * metadata.height > MAX_MEDIA_UPLOAD_PIXELS) {
    throw new MediaSanitizationError(
      'INVALID_IMAGE',
      `Image exceeds the ${MAX_MEDIA_UPLOAD_PIXELS.toLocaleString()} pixel safety limit.`,
    );
  }
  if ((metadata.pages ?? 1) !== 1) {
    throw new MediaSanitizationError(
      'ANIMATED_IMAGE_UNSUPPORTED',
      'Animated or multi-page images are not supported.',
    );
  }
  if (metadata.format !== CONTENT_TYPE_FORMAT[declaredContentType]) {
    throw new MediaSanitizationError(
      'MEDIA_TYPE_MISMATCH',
      'The uploaded bytes do not match the declared image type.',
    );
  }
}

function assertOutputMetadata(metadata: Metadata): void {
  if (hasEmbeddedMetadata(metadata) || metadata.orientation !== undefined) {
    throw new MediaSanitizationError(
      'METADATA_STRIP_FAILED',
      'The sanitized image still contains embedded metadata.',
    );
  }
}

export interface SanitizedImage {
  data: Buffer;
  contentType: SanitizedImageContentType;
  extension: 'jpg' | 'png' | 'webp';
  sizeBytes: number;
  checksumSha256: string;
  width: number;
  height: number;
  sourceMetadataDetected: boolean;
}

export interface VerifiedSanitizedImage {
  width: number;
  height: number;
}

/**
 * Re-open a server-generated canonical image without re-encoding it. Recovery
 * uses this fail-closed check before reconstructing a receipt after a database
 * write failure, so object metadata alone is never treated as proof that the
 * bytes are a decoded, single-frame, metadata-free image.
 */
export async function verifySanitizedImageBytes(
  data: Buffer,
  declaredContentType: string,
): Promise<VerifiedSanitizedImage> {
  if (data.length === 0) {
    throw new MediaSanitizationError('EMPTY_MEDIA', 'Canonical image cannot be empty.');
  }
  if (data.length > MAX_MEDIA_UPLOAD_BYTES) {
    throw new MediaSanitizationError('MEDIA_TOO_LARGE', 'Canonical image exceeds the 10 MB upload limit.');
  }
  if (!SUPPORTED_SANITIZED_IMAGE_TYPES.includes(declaredContentType as SanitizedImageContentType)) {
    throw new MediaSanitizationError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Canonical image type is not supported.',
    );
  }

  try {
    const metadata = await sharp(data, {
      failOn: 'warning',
      limitInputChannels: 4,
      limitInputPixels: MAX_MEDIA_UPLOAD_PIXELS,
      pages: 1,
      unlimited: false,
    }).metadata();
    assertSourceMetadata(metadata, declaredContentType as SanitizedImageContentType);
    assertOutputMetadata(metadata);
    return { width: metadata.width!, height: metadata.height! };
  } catch (error) {
    if (error instanceof MediaSanitizationError) throw error;
    throw new MediaSanitizationError(
      'INVALID_IMAGE',
      error instanceof Error
        ? `Canonical image could not be verified: ${error.message}`
        : 'Canonical image could not be verified.',
    );
  }
}

/**
 * Decode untrusted image bytes to pixels and re-encode them without calling
 * any Sharp metadata-preservation API. Sharp strips EXIF, XMP, IPTC, ICC, and
 * comments by default. The second metadata read is a fail-closed postcondition.
 */
export async function sanitizeImageBytes(
  data: Buffer,
  declaredContentType: string,
): Promise<SanitizedImage> {
  if (data.length === 0) {
    throw new MediaSanitizationError('EMPTY_MEDIA', 'Image cannot be empty.');
  }
  if (data.length > MAX_MEDIA_UPLOAD_BYTES) {
    throw new MediaSanitizationError('MEDIA_TOO_LARGE', 'Image exceeds the 10 MB upload limit.');
  }
  if (!SUPPORTED_SANITIZED_IMAGE_TYPES.includes(declaredContentType as SanitizedImageContentType)) {
    throw new MediaSanitizationError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Only JPEG, PNG, and WebP images can be sanitized safely.',
    );
  }

  const contentType = declaredContentType as SanitizedImageContentType;
  try {
    const source = sharp(data, {
      autoOrient: true,
      failOn: 'warning',
      limitInputChannels: 4,
      limitInputPixels: MAX_MEDIA_UPLOAD_PIXELS,
      pages: 1,
      unlimited: false,
    });
    const sourceMetadata = await source.metadata();
    assertSourceMetadata(sourceMetadata, contentType);

    let outputPipeline = sharp(data, {
      autoOrient: true,
      failOn: 'warning',
      limitInputChannels: 4,
      limitInputPixels: MAX_MEDIA_UPLOAD_PIXELS,
      pages: 1,
      unlimited: false,
    });
    if (contentType === 'image/jpeg') {
      outputPipeline = outputPipeline.jpeg({ quality: 92, progressive: false });
    } else if (contentType === 'image/png') {
      outputPipeline = outputPipeline.png({ compressionLevel: 9, progressive: false });
    } else {
      outputPipeline = outputPipeline.webp({ quality: 92, alphaQuality: 100 });
    }

    const { data: sanitized, info } = await outputPipeline.toBuffer({ resolveWithObject: true });
    if (sanitized.length === 0 || sanitized.length > MAX_MEDIA_UPLOAD_BYTES) {
      throw new MediaSanitizationError(
        'MEDIA_TOO_LARGE',
        'Sanitized image is empty or exceeds the 10 MB upload limit.',
      );
    }

    const outputMetadata = await sharp(sanitized, {
      failOn: 'warning',
      limitInputChannels: 4,
      limitInputPixels: MAX_MEDIA_UPLOAD_PIXELS,
      pages: 1,
      unlimited: false,
    }).metadata();
    assertOutputMetadata(outputMetadata);

    return {
      data: sanitized,
      contentType,
      extension: CONTENT_TYPE_EXTENSION[contentType],
      sizeBytes: sanitized.length,
      checksumSha256: createHash('sha256').update(sanitized).digest('hex'),
      width: info.width,
      height: info.height,
      sourceMetadataDetected: hasEmbeddedMetadata(sourceMetadata),
    };
  } catch (error) {
    if (error instanceof MediaSanitizationError) throw error;
    throw new MediaSanitizationError(
      'INVALID_IMAGE',
      error instanceof Error ? `Image could not be decoded safely: ${error.message}` : 'Image could not be decoded safely.',
    );
  }
}
