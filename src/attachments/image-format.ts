import type { AttachmentFailureCode, StagedImageAttachment } from './model';

interface ImageFormat {
  readonly extension: '.gif' | '.jpg' | '.png' | '.webp';
  readonly mimeType: StagedImageAttachment['mimeType'];
}

const JPEG_SIGNATURE = Buffer.from('FFD8FF', 'hex');
const PNG_SIGNATURE = Buffer.from('89504E470D0A1A0A', 'hex');
const GIF_87_SIGNATURE = Buffer.from('GIF87a', 'ascii');
const GIF_89_SIGNATURE = Buffer.from('GIF89a', 'ascii');
const RIFF_SIGNATURE = Buffer.from('RIFF', 'ascii');
const WEBP_SIGNATURE = Buffer.from('WEBP', 'ascii');
const FILE_TYPE_SIGNATURE = Buffer.from('ftyp', 'ascii');
const WEBP_OFFSET = RIFF_SIGNATURE.length + Uint32Array.BYTES_PER_ELEMENT;
const FILE_TYPE_OFFSET = Uint32Array.BYTES_PER_ELEMENT;
const BRAND_OFFSET = FILE_TYPE_OFFSET + FILE_TYPE_SIGNATURE.length;
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);

const startsWithAt = (bytes: Uint8Array, prefix: Uint8Array, offset = 0): boolean =>
  prefix.every((value, index) => bytes[offset + index] === value);

const imageFormat = (bytes: Uint8Array): AttachmentFailureCode | ImageFormat => {
  if (startsWithAt(bytes, JPEG_SIGNATURE)) {
    return { extension: '.jpg', mimeType: 'image/jpeg' };
  }
  if (startsWithAt(bytes, PNG_SIGNATURE)) {
    return { extension: '.png', mimeType: 'image/png' };
  }
  if (startsWithAt(bytes, GIF_87_SIGNATURE) || startsWithAt(bytes, GIF_89_SIGNATURE)) {
    return { extension: '.gif', mimeType: 'image/gif' };
  }
  if (startsWithAt(bytes, RIFF_SIGNATURE) && startsWithAt(bytes, WEBP_SIGNATURE, WEBP_OFFSET)) {
    return { extension: '.webp', mimeType: 'image/webp' };
  }
  if (startsWithAt(bytes, FILE_TYPE_SIGNATURE, FILE_TYPE_OFFSET)) {
    const brand = Buffer.from(
      bytes.subarray(BRAND_OFFSET, BRAND_OFFSET + FILE_TYPE_SIGNATURE.length),
    ).toString('ascii');
    if (HEIC_BRANDS.has(brand)) {
      return 'heic-unsupported';
    }
  }
  return 'unsupported-type';
};

export { imageFormat };
