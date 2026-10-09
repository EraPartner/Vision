/**
 * Shared saved-parser-config CRUD routes (transaction + portfolio
 * import). Both routers persist into the same custom_parser_configs table, so the
 * id parsing, name normalisation, and the (name, kind)-unique constraint name are
 * identical — kept here so the two routers cannot drift.
 */

import type { Router } from "express";
import { z } from "zod";
import type { ExpressRequest } from "../types/express.ts";
import {
  ValidationError,
  NotFoundError,
  ConflictError,
} from "../middleware/errorHandler.ts";
import { assertIdParam, validateIdParam } from "../middleware/validation.ts";
import customParserConfigService from "../services/customParserConfigService.ts";
import { bareMessages, guardField, parseInput } from "../lib/zodInput.ts";

// (name, kind)-unique since migration 0041; both budgeting and portfolio parsers share it.
export const PARSER_NAME_CONSTRAINT = "uq_custom_parser_configs_name_kind";

// pg's DatabaseError carries the SQLSTATE in `code` and the violated
// constraint in `constraint`.
function isParserNameConflict(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "23505" &&
    "constraint" in err &&
    err.constraint === PARSER_NAME_CONSTRAINT
  );
}

/**
 * Parse `:id` for the PATCH/DELETE parser-config handlers.
 *
 * Delegates to `validateId` so the accept set is the one every other `:id`
 * param uses: a plain base-10 digit string or an integer number, 1..2^31-1.
 * The routes also carry validation-only `validateIdParam` at the boundary.
 * This point-of-use parser is the explicit numeric handoff to the service.
 *
 * It was `parseInt` guarded only by `Number.isNaN`, which takes the leading
 * digits of anything: `DELETE /parsers/12abc` returned **204 having deleted
 * parser 12**, `12.5` hit 12 and `1e3` hit 1 — an irreversible delete of a
 * record the caller never named, reported as success. `-1` and `0` cleared the
 * NaN check too and reached the repository as-is.
 */
export function parseParserId(req: ExpressRequest): number {
  return assertIdParam(req);
}

export function normalizeParserName(name: unknown): string {
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new ValidationError('Missing or invalid "name"');
  }
  return name.trim();
}

/**
 * POST and PATCH bodies. POST requires both fields; PATCH leaves an absent
 * field unchanged. Each field keeps its normaliser's 400 message.
 */
function parserBodySchemas(normalizeConfig: (config: unknown) => object) {
  const name = guardField(normalizeParserName);
  const config = guardField(normalizeConfig);
  return {
    create: bareMessages(z.looseObject({ name, config })),
    update: bareMessages(
      z.looseObject({ name: name.optional(), config: config.optional() }),
    ),
  };
}

/**
 * Register the four saved-parser-config CRUD handlers (GET/POST/PATCH/DELETE
 * /parsers[/:id]) on a router. The transaction and portfolio import routers are
 * identical here apart from the parser `kind`, the config normaliser, and the
 * word in the conflict message — parameterised so the two cannot drift (SIMP-30).
 *
 * `label` is inserted into the 23505 conflict message ("A <label>parser named …").
 */
// `typeof Router`, not `import type { Router }`: the legacy checkJs program
// resolves `express` to an untyped shim that has no type exports.
export function registerParserRoutes(
  router: ReturnType<typeof Router>,
  {
    kind,
    normalizeConfig,
    label = "",
  }: {
    kind: string;
    normalizeConfig: (config: unknown) => object;
    label?: string;
  },
) {
  const conflictMessage = (name: string | undefined) =>
    `A ${label}parser named "${name}" already exists`;
  const bodySchemas = parserBodySchemas(normalizeConfig);

  // Canonical collection shape `{items, total}`. Unpaginated, so `total` is
  // just the row count — it exists so pagination can be added without a
  // breaking response-shape change.
  router.get("/parsers", async (req, res) => {
    const items = await customParserConfigService.getAll(kind);
    res.ok({ items, total: items.length });
  });

  router.post("/parsers", async (req, res) => {
    const { name, config } = parseInput(bodySchemas.create, req.body ?? {});
    try {
      const created = await customParserConfigService.create({
        name,
        config,
        kind,
      });
      res.status(201);
      res.ok(created);
    } catch (err) {
      if (isParserNameConflict(err)) {
        throw new ConflictError(conflictMessage(name));
      }
      throw err;
    }
  });

  // validateIdParam on both id-bearing operations, as every other `:id` route
  // in the app has: the guard belongs at the router edge, not only inside the
  // handler, so a malformed id never reaches a repository call.
  router.patch("/parsers/:id", validateIdParam, async (req, res) => {
    const id = parseParserId(req);
    const { name, config } = parseInput(bodySchemas.update, req.body ?? {});
    try {
      const updated = await customParserConfigService.update(id, {
        name,
        config,
      });
      if (!updated) throw new NotFoundError("Parser config not found");
      res.ok(updated);
    } catch (err) {
      if (isParserNameConflict(err)) {
        throw new ConflictError(conflictMessage(name));
      }
      throw err;
    }
  });

  router.delete("/parsers/:id", validateIdParam, async (req, res) => {
    const id = parseParserId(req);
    const deleted = await customParserConfigService.delete(id);
    if (!deleted) throw new NotFoundError("Parser config not found");
    res.status(204).send();
  });
}
