import { createGzip } from "node:zlib";

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 * @typedef {import('../types/express.js').ExpressNextFunction} ExpressNextFunction
 */

const COMPRESSIBLE_RE = /json|text|javascript|xml|svg|x-www-form-urlencoded/;
const NO_COMPRESS_BELOW = 1024;

/**
 * Quality-aware `Accept-Encoding` check. An explicit gzip entry takes
 * precedence over `*`, so `gzip;q=0, *;q=1` still refuses gzip.
 * @param {string|string[]|undefined} value
 */
export function acceptsGzip(value) {
  const entries = (Array.isArray(value) ? value : [value ?? ""])
    .flatMap((part) => String(part).split(","))
    .map((part) => part.trim())
    .filter(Boolean);
  let wildcardQuality;

  for (const entry of entries) {
    const [rawName, ...parameters] = entry.split(";");
    const name = rawName.trim().toLowerCase();
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)$/i.exec(
        parameter.trim(),
      );
      if (match) quality = Number(match[1]);
      else if (/^q\s*=/i.test(parameter.trim())) quality = 0;
    }
    if (name === "gzip") return quality > 0;
    if (name === "*") wildcardQuality = quality;
  }

  return (wildcardQuality ?? 0) > 0;
}

/**
 * Zero-dependency response compression using node:zlib.
 *
 * @param {ExpressRequest} req
 * @param {ExpressResponse} res
 * @param {ExpressNextFunction} next
 */
export function compression(req, res, next) {
  if (!acceptsGzip(req.headers["accept-encoding"])) return next();

  const originalWrite =
    /** @type {(chunk?: any, encoding?: any, cb?: any) => boolean} */ (
      res.write.bind(res)
    );
  const originalEnd =
    /** @type {(chunk?: any, encoding?: any, cb?: any) => ExpressResponse} */ (
      res.end.bind(res)
    );
  /** @type {import('node:zlib').Gzip|null} */
  let gzip = null;
  let setupDone = false;

  const setup = () => {
    if (setupDone) return;
    setupDone = true;
    if (res.headersSent) return;
    const contentType = String(res.getHeader("Content-Type") ?? "");
    const contentLength = parseInt(
      String(res.getHeader("Content-Length") ?? "0"),
      10,
    );
    // A downstream static-asset cache may already have supplied precompressed
    // bytes. Do not wrap those bytes in a second gzip stream.
    if (res.getHeader("Content-Encoding")) return;
    // Gzip buffering would batch Server-Sent Events instead of delivering each event.
    if (contentType.includes("text/event-stream")) return;
    if (String(res.getHeader("X-Accel-Buffering") ?? "").toLowerCase() === "no")
      return;
    if (!COMPRESSIBLE_RE.test(contentType)) return;
    if (contentLength > 0 && contentLength < NO_COMPRESS_BELOW) return;

    gzip = createGzip();
    res.removeHeader("Content-Length");
    res.setHeader("Content-Encoding", "gzip");
    const existingVary = String(res.getHeader("Vary") ?? "");
    if (!/\bAccept-Encoding\b/i.test(existingVary)) {
      res.setHeader(
        "Vary",
        existingVary ? `${existingVary}, Accept-Encoding` : "Accept-Encoding",
      );
    }

    gzip.on("data", (chunk) => {
      if (originalWrite(chunk) === false) {
        gzip.pause();
        res.once("drain", () => gzip.resume());
      }
    });
    gzip.on("end", () => originalEnd());
    gzip.on("drain", () => res.emit("drain"));
    gzip.on("error", (err) => res.destroy(err));
  };

  // ServerResponse write/end are overloaded. These arguments deliberately
  // mirror the genuine polymorphic shape instead of narrowing it locally.
  res.write = (
    /** @type {any} */ chunk,
    /** @type {any} */ encoding,
    /** @type {any} */ cb,
  ) => {
    setup();
    if (gzip) return gzip.write(chunk, encoding, cb);
    return originalWrite(chunk, encoding, cb);
  };

  res.end = (
    /** @type {any} */ chunk,
    /** @type {any} */ encoding,
    /** @type {any} */ cb,
  ) => {
    setup();
    if (gzip) {
      if (typeof chunk === "function") {
        cb = chunk;
        chunk = undefined;
      } else if (typeof encoding === "function") {
        cb = encoding;
        encoding = undefined;
      }
      if (chunk != null && chunk !== "") gzip.write(chunk, encoding);
      gzip.end();
      if (typeof cb === "function") gzip.once("end", cb);
      return res;
    }
    return originalEnd(chunk, encoding, cb);
  };

  next();
}
