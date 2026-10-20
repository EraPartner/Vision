/**
 * HTTP-level scope of the strict import limiter: review traffic (preview
 * reads, per-row overrides) must not share the 20/min budget meant for uploads
 * and commits, or a quick review session or group assignment fails with 429.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/config.ts", () => ({
  default: { isDevelopment: () => false },
}));

import {
  IMPORT_RATE_LIMITED_PATHS,
  importRateLimiter,
} from "../src/middleware/rateLimiter.ts";

function createApp() {
  const app = express();
  app.use(IMPORT_RATE_LIMITED_PATHS, importRateLimiter);
  const ok = (_req: express.Request, res: express.Response) => {
    res.status(204).end();
  };
  app.get("/api/import/batches/:id/preview", ok);
  app.post("/api/import/batches/:id/rows/:rowId/override", ok);
  app.post("/api/import/batches/:id/rows/:rowId/category-override", ok);
  app.get("/api/portfolio/import/batches/:id/preview", ok);
  app.post("/api/portfolio/import/batches/:id/rows/investment-override", ok);
  app.post("/api/import/csv/stream", ok);
  app.post("/api/import/batches/:id/commit", ok);
  // Express turns a limiter rejection into an error; surface its status.
  app.use(
    (
      err: { statusCode?: number; status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.statusCode ?? err.status ?? 500).end();
    },
  );
  return app;
}

describe("import rate limit scope", () => {
  it("lets review edits through while still limiting uploads and commits", async () => {
    const app = createApp();
    const batch = "11111111-1111-4111-8111-111111111111";

    // 30 rows assigned at once plus the preview refetches of a review session.
    const review = [];
    for (let row = 1; row <= 30; row++) {
      review.push(
        await request(app).post(
          `/api/import/batches/${batch}/rows/${row}/override`,
        ),
        await request(app).post(
          `/api/import/batches/${batch}/rows/${row}/category-override`,
        ),
        await request(app).get(`/api/import/batches/${batch}/preview`),
      );
    }
    review.push(
      await request(app).get(`/api/portfolio/import/batches/7/preview`),
      await request(app).post(
        `/api/portfolio/import/batches/7/rows/investment-override`,
      ),
    );
    expect(review.map((res) => res.status)).toEqual(review.map(() => 204));

    const uploads = [];
    for (let i = 0; i < 20; i++) {
      uploads.push(await request(app).post("/api/import/csv/stream"));
    }
    expect(uploads.map((res) => res.status)).toEqual(uploads.map(() => 204));
    expect(
      (await request(app).post("/api/import/csv/stream")).status,
    ).toBe(429);
    expect(
      (await request(app).post(`/api/import/batches/${batch}/commit`)).status,
    ).toBe(429);
  });
});
