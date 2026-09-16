import sharp from 'sharp';
import { MediaError } from './errors.js';

/** @typedef {import('../types.js').VariantSpec} VariantSpec */

/**
 * Image inspection, normalisation and variant generation on top of sharp.
 * Every decode is bounded by `maxPixels` (decompression-bomb protection).
 */
export class ImageProcessor {
  /** @param {{ maxPixels: number, quality: number }} o */
  constructor({ maxPixels, quality }) {
    this.maxPixels = maxPixels;
    this.quality = quality;
    sharp.cache(false);
  }

  /**
   * @param {string|Buffer} input
   * @param {{ animated?: boolean }} [o]
   */
  #open(input, { animated = false } = {}) {
    return sharp(input, { limitInputPixels: this.maxPixels, animated, failOn: 'error', sequentialRead: true });
  }

  /**
   * Validate that the bytes decode as an image and return its dimensions (after EXIF orientation).
   * @param {string|Buffer} input
   * @returns {Promise<{ width: number, height: number, format: string, pages: number }>}
   */
  async inspect(input) {
    let meta;
    try {
      meta = await this.#open(input).metadata();
    } catch (err) {
      throw ImageProcessor.#mapError(err);
    }
    if (!meta.width || !meta.height) throw new MediaError('INVALID_IMAGE', 'image has no dimensions');
    if (meta.width * meta.height > this.maxPixels) throw new MediaError('INVALID_IMAGE', `image exceeds ${this.maxPixels} pixels`);
    const swap = (meta.orientation ?? 1) >= 5;
    return { width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height, format: meta.format ?? 'unknown', pages: meta.pages ?? 1 };
  }

  /**
   * Re-encode in the same format with orientation applied and all metadata (EXIF, GPS, XMP, ICC
   * kept) dropped. Also defeats polyglot files: the output is a clean encoder product.
   * @param {string} inputPath
   * @param {string} mime
   * @returns {Promise<{ buffer: Buffer, width: number, height: number }>}
   */
  async normalize(inputPath, mime) {
    try {
      const animated = mime === 'image/gif';
      let img = this.#open(inputPath, { animated }).rotate().keepIccProfile();
      switch (mime) {
        case 'image/jpeg': img = img.jpeg({ quality: 92, mozjpeg: true }); break;
        case 'image/png': img = img.png({ compressionLevel: 9, palette: false }); break;
        case 'image/webp': img = img.webp({ quality: 92, effort: 4 }); break;
        case 'image/gif': img = img.gif(); break;
        case 'image/avif': img = img.avif({ quality: 70, effort: 4 }); break;
        default: throw new MediaError('NOT_AN_IMAGE', `cannot normalise ${mime}`);
      }
      const { data, info } = await img.toBuffer({ resolveWithObject: true });
      const height = animated && info.pageHeight ? info.pageHeight : info.height;
      return { buffer: data, width: info.width, height };
    } catch (err) {
      throw ImageProcessor.#mapError(err);
    }
  }

  /**
   * Resize to a preset and encode as WebP without metadata. Never enlarges.
   * @param {string} inputPath
   * @param {VariantSpec} spec
   * @returns {Promise<Buffer>}
   */
  async variant(inputPath, spec) {
    try {
      return await this.#open(inputPath)
        .rotate()
        .resize({ width: spec.width, height: spec.height ?? undefined, fit: spec.fit, withoutEnlargement: true, position: 'attention' })
        .webp({ quality: this.quality, effort: 4 })
        .toBuffer();
    } catch (err) {
      throw ImageProcessor.#mapError(err);
    }
  }

  /** @param {unknown} err */
  static #mapError(err) {
    if (err instanceof MediaError) return err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/pixel limit/i.test(msg)) return new MediaError('INVALID_IMAGE', 'image exceeds the pixel limit');
    return new MediaError('INVALID_IMAGE', `image could not be decoded: ${msg.split('\n')[0].slice(0, 200)}`);
  }
}
