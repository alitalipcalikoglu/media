import { TypeSniffer } from '../storage/type-sniffer.js';

/** Turns whatever the client called the file into a safe name whose extension matches its real type. */
export class FileName {
  static MAX_LENGTH = 120;

  /**
   * @param {string|null|undefined} raw
   * @param {string} mime Sniffed type.
   * @returns {string}
   */
  static sanitize(raw, mime) {
    const ext = TypeSniffer.extension(mime);
    let base = (raw ?? '').split(/[\\/]/).pop() ?? '';
    base = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim().replace(/^\.+/, '');
    base = base.replace(/\.[A-Za-z0-9]{1,8}$/, ''); // client extension is untrusted
    base = base.slice(0, FileName.MAX_LENGTH - ext.length - 1).trim();
    return `${base || 'file'}.${ext}`;
  }

  /**
   * RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename*.
   * @param {'inline'|'attachment'} type
   * @param {string} name
   */
  static disposition(type, name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
}
