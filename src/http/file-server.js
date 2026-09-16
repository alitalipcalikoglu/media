import { createReadStream } from 'node:fs';
import { FileName } from '../domain/file-name.js';
import { TypeSniffer } from '../storage/type-sniffer.js';

/** @typedef {import('../types.js').FileRecord} FileRecord */

/**
 * Streams stored bytes with strong ETags, conditional requests, single-range support and
 * type-appropriate security headers. Immutable objects → long cache lifetimes.
 */
export class FileServer {
  static PUBLIC_CACHE = 'public, max-age=31536000, immutable';
  static PRIVATE_CACHE = 'private, max-age=0, no-store';

  /**
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   * @param {FileRecord} file
   * @param {{ path: string, mime: string, size: number }} target
   * @param {string} variant
   */
  async send(request, reply, file, target, variant) {
    const etag = `"${file.sha256.slice(0, 32)}-${variant}"`;
    reply.header('etag', etag);
    reply.header('accept-ranges', 'bytes');
    reply.header('cache-control', file.visibility === 'public' ? FileServer.PUBLIC_CACHE : FileServer.PRIVATE_CACHE);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-type', target.mime);
    // Images render inline; everything else downloads, sandboxed, so a hostile PDF or SVG cannot script.
    const inline = TypeSniffer.isImage(target.mime);
    reply.header('content-disposition', FileName.disposition(inline ? 'inline' : 'attachment', FileServer.#variantName(file.name, variant, target.mime)));
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    if (!inline) reply.header('x-frame-options', 'DENY');

    if (request.headers['if-none-match']?.split(',').map((s) => s.trim()).includes(etag)) {
      return reply.code(304).send();
    }

    const range = FileServer.#parseRange(request.headers.range, target.size);
    if (range === 'unsatisfiable') {
      reply.header('content-range', `bytes */${target.size}`);
      return reply.code(416).send();
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : target.size - 1;
    reply.header('content-length', String(end - start + 1));
    if (range) {
      reply.header('content-range', `bytes ${start}-${end}/${target.size}`);
      reply.code(206);
    }
    if (request.method === 'HEAD') {
      // Fastify would overwrite Content-Length with 0 for an empty body; write the headers by hand.
      reply.hijack();
      reply.raw.writeHead(reply.statusCode, /** @type {Record<string, string>} */ (reply.getHeaders()));
      reply.raw.end();
      return reply;
    }
    return reply.send(createReadStream(target.path, { start, end }));
  }

  /**
   * @param {string} name
   * @param {string} variant
   * @param {string} mime
   */
  static #variantName(name, variant, mime) {
    if (variant === 'original') return name;
    const stem = name.replace(/\.[^.]+$/, '');
    return `${stem}-${variant}.${TypeSniffer.extension(mime)}`;
  }

  /**
   * Single byte range only; multi-range requests are answered with the whole body.
   * @param {string|undefined} header
   * @param {number} size
   * @returns {{ start: number, end: number }|'unsatisfiable'|null}
   */
  static #parseRange(header, size) {
    if (!header) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m || (m[1] === '' && m[2] === '')) return null;
    let start;
    let end;
    if (m[1] === '') {
      const suffix = Number(m[2]);
      if (suffix === 0) return 'unsatisfiable';
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || start > end) return 'unsatisfiable';
    return { start, end };
  }
}
