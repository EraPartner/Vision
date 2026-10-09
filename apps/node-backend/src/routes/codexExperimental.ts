import { Router } from "express";
import { z } from "zod";
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
} from "../middleware/errorHandler.ts";
import { parseInput } from "../lib/zodInput.ts";
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

const NO_PAYLOAD = "This route accepts no data payload";
// Express leaves `req.body` undefined without a JSON body; `{}` is an empty one.
const emptyBodySchema = z.union(
  [z.undefined(), z.strictObject({}, { error: NO_PAYLOAD })],
  { error: NO_PAYLOAD },
);

function emptyBody(
  req: ExpressRequest,
  _res: ExpressResponse,
  next: ExpressNextFunction,
): void {
  parseInput(emptyBodySchema, req.body);
  next();
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
