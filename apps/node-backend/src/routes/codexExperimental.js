import { Router } from "express";
import { isAbsolute } from "node:path";
import settings from "../config/config.js";
import { isLoopbackHost } from "../middleware/adminAuth.js";
import {
  AppError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "../middleware/errorHandler.js";
import { createExperimentalCodexSession } from "../integrations/codex/experimentalSession.js";

const router = Router();
const session = createExperimentalCodexSession({
  binary: process.env.VISION_EXPERIMENTAL_CODEX_BINARY,
});

/** @param {{flag?: string, binary?: string, token?: string, peer?: string}} options */
function experimentalAccessDecision({ flag, binary, token, peer }) {
  if (flag !== "1" || typeof binary !== "string" || !isAbsolute(binary))
    return "disabled";
  if (!isLoopbackHost(peer)) return "forbidden";
  if (!token) return "unauthorized";
  return "allowed";
}

function enabled(req, _res, next) {
  const decision = experimentalAccessDecision({
    flag: process.env.VISION_EXPERIMENTAL_CODEX,
    binary: process.env.VISION_EXPERIMENTAL_CODEX_BINARY,
    token: settings.admin.authToken,
    peer: req.socket?.remoteAddress,
  });
  if (decision === "disabled") {
    return next(
      new AppError("Experimental Codex route is disabled", { status: 503 }),
    );
  }
  if (decision === "forbidden") {
    return next(new ForbiddenError("Experimental Codex requires loopback"));
  }
  // The normal admin middleware accepts tokenless loopback requests. This
  // experimental external-auth route requires a real per-request admin token.
  if (decision === "unauthorized") {
    return next(new UnauthorizedError("Admin token required"));
  }
  return next();
}

function emptyBody(req, _res, next) {
  if (
    req.body === undefined ||
    (req.body &&
      typeof req.body === "object" &&
      !Array.isArray(req.body) &&
      Object.keys(req.body).length === 0)
  ) {
    return next();
  }
  return next(new ValidationError("This route accepts no data payload"));
}

function safeHandler(operation) {
  return async (req, res, next) => {
    try {
      res.ok(await operation());
    } catch (error) {
      next(
        new AppError("Experimental Codex operation failed", {
          status: 503,
          cause: error,
        }),
      );
    }
  };
}

router.use(enabled);
router.get(
  "/status",
  safeHandler(() => session.status()),
);
router.post(
  "/session",
  emptyBody,
  safeHandler(() => session.start().then(() => session.status())),
);
router.post(
  "/login",
  emptyBody,
  safeHandler(() => session.login()),
);
router.post(
  "/synthetic-turn",
  emptyBody,
  safeHandler(() => session.runSynthetic()),
);
router.post(
  "/logout",
  emptyBody,
  safeHandler(() =>
    session.logout().then((result) => ({ running: false, ...result })),
  ),
);

export default router;

export {
  experimentalAccessDecision as __experimentalAccessDecision,
};
