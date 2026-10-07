import { createGzip } from "node:zlib";
import type { Gzip } from "node:zlib";
import type {
  ExpressNextFunction,
  ExpressRequest,
  ExpressResponse,
} from "../types/express.ts";

/**
 * The Node `ServerResponse` members this middleware relies on. They are
 * always present on a real response; the shared shape marks them optional.
 */
type CompressibleResponse = ExpressResponse &
  Required<
    Pick<
      ExpressResponse,
      "getHeader" | "removeHeader" | "once" | "emit" | "destroy"
    >
  >;

const COMPRESSIBLE_RE = /json|text|javascript|xml|svg|x-www-form-urlencoded/;
const NO_COMPRESS_BELOW = 1024;

/**
 * Quality-aware `Accept-Encoding` check. An explicit gzip entry takes
 * precedence over `*`, so `gzip;q=0, *;q=1` still refuses gzip.
 */
export function acceptsGzip(value: string | string[] | undefined): boolean {
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
 */
export function compression(
  req: ExpressRequest,
  res: CompressibleResponse,
  next: ExpressNextFunction,
) {
  if (!acceptsGzip(req.headers["accept-encoding"])) return next();

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  let gzip: Gzip | null = null;
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

    const stream = createGzip();
    gzip = stream;
    res.removeHeader("Content-Length");
    res.setHeader("Content-Encoding", "gzip");
    const existingVary = String(res.getHeader("Vary") ?? "");
    if (!/\bAccept-Encoding\b/i.test(existingVary)) {
      res.setHeader(
        "Vary",
        existingVary ? `${existingVary}, Accept-Encoding` : "Accept-Encoding",
      );
    }

    stream.on("data", (chunk) => {
      if (originalWrite(chunk) === false) {
        stream.pause();
        res.once("drain", () => stream.resume());
      }
    });
    stream.on("end", () => originalEnd());
    stream.on("drain", () => res.emit("drain"));
    stream.on("error", (err) => res.destroy(err));
  };

  // ServerResponse write/end are overloaded. These arguments deliberately
  // mirror the genuine polymorphic shape instead of narrowing it locally
  // (their types come from the shared `ExpressResponse` write/end signatures).
  res.write = (chunk, encoding, cb) => {
    setup();
    if (gzip) return gzip.write(chunk, encoding, cb);
    return originalWrite(chunk, encoding, cb);
  };

  res.end = (chunk, encoding, cb) => {
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
