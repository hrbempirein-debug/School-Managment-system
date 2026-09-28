/**
 * Shared magic-byte content sniffing for binary uploads.
 *
 * Single source of truth used by BOTH sides of the document pipeline:
 *   * the API upload route (acceptance — the bytes must be one of the allowed
 *     raster/PDF formats before storage, and a declared content-type must match),
 *   * the worker scan hook (verification — a stored object is re-sniffed on scan;
 *     a mismatch with the recorded MIME is treated as tampering / blocked).
 * Keeping the rules in one place prevents the two sides from drifting apart.
 */

export type ImageType = 'png' | 'jpeg' | 'webp';
export type DocumentType = ImageType | 'pdf';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP_MAGIC = 'WEBP';
const PDF_SIGNATURE = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

export const DOCUMENT_MIME: Record<DocumentType, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

export const DOCUMENT_EXT: Record<DocumentType, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  pdf: 'pdf',
};

/** Detects the allowed raster image formats regardless of the declared type. */
export function detectImageType(data: Buffer): ImageType | null {
  if (data.length >= PNG_SIGNATURE.length && data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'png';
  }
  if (data.length >= JPEG_SIGNATURE.length && data.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return 'jpeg';
  }
  if (
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === WEBP_MAGIC
  ) {
    return 'webp';
  }
  return null;
}

/** Detects raster images OR PDF (%PDF- header). Returns null for anything else. */
export function detectDocumentType(data: Buffer): DocumentType | null {
  const image = detectImageType(data);
  if (image) return image;
  if (data.length >= PDF_SIGNATURE.length && data.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
    return 'pdf';
  }
  return null;
}