import express from "express";
import type { Router } from "express";
import { posix, resolve } from "node:path";
import { NotFoundError } from "./errorHandler.ts";

export const NATIVE_HELPER_DOCUMENT_PATH = "/native-helper.html";
export const NATIVE_HELPER_ASSET_PREFIX = "/native-helper-assets";

function isReservedNamespace(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return (
    lower === NATIVE_HELPER_DOCUMENT_PATH ||
    lower.startsWith(`${NATIVE_HELPER_DOCUMENT_PATH}/`) ||
    lower === NATIVE_HELPER_ASSET_PREFIX ||
    lower.startsWith(`${NATIVE_HELPER_ASSET_PREFIX}/`)
  );
}

function isCanonicalNamespace(pathname: string): boolean {
  return (
    pathname === NATIVE_HELPER_DOCUMENT_PATH ||
    pathname.startsWith(`${NATIVE_HELPER_DOCUMENT_PATH}/`) ||
    pathname === NATIVE_HELPER_ASSET_PREFIX ||
    pathname.startsWith(`${NATIVE_HELPER_ASSET_PREFIX}/`)
  );
}

/**
 * Reserve only the optional helper artifacts before generic static/SPA serving.
 * The trusted production dist root is injected; request values never select a
 * filesystem root. Missing files propagate to the existing 4xx error handler.
 */
export function createNativeHelperArtifactRouter(distPath: string): Router {
  const router = express.Router({ caseSensitive: true, strict: true });
  const documentPath = resolve(distPath, "native-helper.html");
  const assetsPath = resolve(distPath, "native-helper-assets");

  router.use((req, res, next) => {
    const raw = req.path;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      if (!isReservedNamespace(raw)) return next();
      res.setHeader("Cache-Control", "no-cache");
      return next(new NotFoundError("Native helper artifact not found"));
    }
    const separators = decoded.replaceAll("\\", "/");
    const normalized = posix.normalize(separators);
    if (!isReservedNamespace(separators) && !isReservedNamespace(normalized))
      return next();
    res.setHeader("Cache-Control", "no-cache");
    // Built helper URLs have one canonical spelling. Reject aliases before the
    // generic dist server can decode/normalize them to another file or the SPA.
    // Asset basenames may contain uppercase content hashes; only the reserved
    // namespace itself is case-sensitive.
    if (raw !== decoded || raw !== normalized || !isCanonicalNamespace(raw)) {
      return next(new NotFoundError("Native helper artifact not found"));
    }
    next();
  });

  router.get(NATIVE_HELPER_DOCUMENT_PATH, (_req, res, next) => {
    res.sendFile(
      documentPath,
      { headers: { "Cache-Control": "no-cache" } },
      (error) => {
        if (error) next(error);
      },
    );
  });
  router.use(
    NATIVE_HELPER_ASSET_PREFIX,
    express.static(assetsPath, {
      maxAge: "1y",
      immutable: true,
      index: false,
      redirect: false,
      fallthrough: false,
      dotfiles: "deny",
      setHeaders: (res) => {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );
  router.use((req, _res, next) => {
    if (isReservedNamespace(req.path))
      return next(new NotFoundError("Native helper artifact not found"));
    next();
  });
  return router;
}
