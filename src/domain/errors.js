/** Domain error with a stable code and the HTTP status the API maps it to. */
export class MediaError extends Error {
  /** @type {Record<string, number>} */
  static STATUS = {
    NOT_FOUND: 404,
    UNKNOWN_VARIANT: 404,
    FORBIDDEN: 403,
    INVALID_TICKET: 401,
    INVALID_ARGUMENT: 400,
    EMPTY: 400,
    STREAM_ERROR: 400,
    NOT_AN_IMAGE: 400,
    TOO_LARGE: 413,
    UNSUPPORTED_TYPE: 415,
    INVALID_IMAGE: 422,
  };

  /**
   * @param {keyof typeof MediaError.STATUS} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    this.statusCode = MediaError.STATUS[code];
    this.details = details;
  }
}
