import { Router } from "express";
import type {
  ExpressNextFunction,
  ExpressRequest,
  ExpressResponse,
} from "../types/express.ts";
import { isAbsolute } from "node:path";
import settings from "../config/config.ts";
import { isLoopbackHost } from "../middleware/adminAuth.ts";
import {
  AppError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "../middleware/errorHandler.ts";
import { createExperimentalCodexSession } from "../integrations/codex/experimentalSession.ts";

const router = Router();
const session = createExperimentalCodexSession({
  binary: process.env.VISION_EXPERIMENTAL_CODEX_BINARY,
});

type ExperimentalAccessDecision =
  "disabled" | "forbidden" | "unauthorized" | "allowed";

function experimentalAccessDecision({
  flag,
  binary,
  token,
  peer,
}: {
  flag?: string;
  binary?: string;
  token?: string;
  peer?: string;
}): ExperimentalAccessDecision {
  if (flag !== "1" || typeof binary !== "string" || !isAbsolute(binary))
    return "disabled";
  if (!isLoopbackHost(peer)) return "forbidden";
  if (!token) return "unauthorized";
  return "allowed";
}

function enabled(
  req: ExpressRequest,
  _res: ExpressResponse,
  next: ExpressNextFunction,
): void {
  const decision = experimentalAccessDecision({
    flag: process.env.VISION_EXPERIMENTAL_CODEX,
    binary: process.env.VISION_EXPERIMENTAL_CODEX_BINARY,
    token: settings.admin.authToken,
    peer: req.socket?.remoteAddress,
  });
  if (decision === "disabled") {
    next(new AppError("Experimental Codex route is disabled", { status: 503 }));
    return;
  }
  if (decision === "forbidden") {
    next(new ForbiddenError("Experimental Codex requires loopback"));
    return;
  }
  // The normal admin middleware accepts tokenless loopback requests. This
  // experimental external-auth route requires a real per-request admin token.
  if (decision === "unauthorized") {
    next(new UnauthorizedError("Admin token required"));
    return;
  }
  next();
}

function emptyBody(
  req: ExpressRequest,
  _res: ExpressResponse,
  next: ExpressNextFunction,
): void {
  if (
    req.body === undefined ||
    (req.body &&
      typeof req.body === "object" &&
      !Array.isArray(req.body) &&
      Object.keys(req.body).length === 0)
  ) {
    next();
    return;
  }
  next(new ValidationError("This route accepts no data payload"));
}

function safeHandler(operation: () => Promise<unknown>) {
  return async (
    _req: ExpressRequest,
    // The envelope middleware always installs `ok`; ExpressResponse marks it optional.
    res: Required<Pick<ExpressResponse, "ok">>,
    next: ExpressNextFunction,
  ) => {
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

export { experimentalAccessDecision as __experimentalAccessDecision };
