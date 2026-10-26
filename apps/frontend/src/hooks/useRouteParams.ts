import { useParams } from "react-router";
import { AccountIdSchema } from "@vision/types/brands";
import { z } from "zod";
import {
    asImportBatchId,
    asPortfolioImportBatchId,
    ROUTES,
    type RouteParamTypes,
} from "@/lib/routes";

/** A path param as the URL carries it: plain digits, read as a positive integer. */
const idParam = z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.int().positive());

export type ParameterisedRoute = keyof RouteParamTypes;

type RawParams = Readonly<Record<string, string | undefined>>;

type Parsers = {
    [P in ParameterisedRoute]: (raw: RawParams) => RouteParamTypes[P] | null;
};

const PARSERS: Parsers = {
    [ROUTES.account]: (raw) => {
        const parsed = idParam.pipe(AccountIdSchema).safeParse(raw.id);
        return parsed.success ? { id: parsed.data } : null;
    },
    [ROUTES.importReview]: (raw) => {
        const parsed = idParam.safeParse(raw.batchId);
        return parsed.success ? { batchId: asImportBatchId(parsed.data) } : null;
    },
    [ROUTES.portfolioImportReview]: (raw) => {
        const parsed = idParam.safeParse(raw.batchId);
        return parsed.success
            ? { batchId: asPortfolioImportBatchId(parsed.data) }
            : null;
    },
    // `:table` is a name, not an id; react-router has already decoded it.
    [ROUTES.adminDbTable]: (raw) => (raw.table ? { table: raw.table } : null),
};

/** Pure parser behind `useRouteParams`, exposed for tests. */
export function parseRouteParams<P extends ParameterisedRoute>(
    pattern: P,
    raw: RawParams,
): RouteParamTypes[P] | null {
    return PARSERS[pattern](raw);
}

/**
 * Typed `useParams`: parses the current route's params into branded ids.
 * Returns `null` when a param is malformed (`/accounts/abc`, `/accounts/0`),
 * so the page can take the same not-found / error path it takes for an id the
 * server does not know.
 */
export function useRouteParams<P extends ParameterisedRoute>(
    pattern: P,
): RouteParamTypes[P] | null {
    return parseRouteParams(pattern, useParams());
}
