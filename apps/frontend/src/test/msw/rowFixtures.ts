/**
 * Builders for realistic response rows of the reads the frontend checks
 * against `@vision/types/contracts` (ADR-193): transactions, accounts,
 * categories and recipients. A test passes only the fields it cares about;
 * every other field the backend always sends is filled with a neutral real
 * value (SQL NULL for a nullable column, the column default otherwise), so the
 * row passes the wire contract without inventing data the test does not
 * assert on.
 */

const TS = "2025-01-01T00:00:00.000Z";

type Row = Record<string, unknown>;

/**
 * `{ ...defaults, ...fields }`, typed as a spread: a plain generic spread is an
 * intersection, which collapses to `never` when a test overrides a `null`
 * default with a value.
 */
function merge<D extends Row, T extends Row>(
    defaults: D,
    fields: T,
): Omit<D, keyof T> & T {
    return { ...defaults, ...fields };
}

/** One `formatTransaction` row (routes/transactions.ts). */
export function transactionRow<T extends Row>(fields: T) {
    const amount = typeof fields.amount === "number" ? fields.amount : 0;
    return merge(
        {
            id: 1,
            transaction_date: "2025-01-15",
            bank_account: null,
            account_id: null,
            is_transfer: false,
            transfer_peer_id: null,
            transfer_source: null,
            recipient_id: 1,
            recipient_name: null,
            memo: null,
            amount,
            amount_eur: amount,
            currency: "EUR",
            balance: null,
            category_id: null,
            category_name: null,
            comment: null,
            tags: [],
            is_active: true,
            created_at: TS,
            updated_at: TS,
            links: [],
        },
        fields,
    );
}

interface ListBody<T> {
    items: T[];
    total?: number;
    limit?: number;
    offset?: number;
    links?: unknown[];
    [key: string]: unknown;
}

/** An always-paginated list body: `items`, `total`, `limit`, `offset`, `links`. */
function pageBody<T>(body: ListBody<T>, defaultLimit: number) {
    return {
        limit: defaultLimit,
        offset: 0,
        links: [],
        ...body,
        total: body.total ?? body.items.length,
    };
}

/** `POST /api/transactions`: the formatted row plus `auto_linked`. */
export function transactionCreated<T extends Row>(fields: T) {
    return merge({ ...transactionRow(fields), auto_linked: null }, fields);
}

/** `GET /api/transactions` body (always paginated). */
export function transactionsBody<T>(body: ListBody<T>) {
    return pageBody(body, 50);
}

/** An enriched recipient plus `links: []` (list, detail, merge primary). */
export function recipientRow<T extends Row>(fields: T) {
    const name = typeof fields.name === "string" ? fields.name : "RECIPIENT";
    return merge(
        {
            id: 1,
            name,
            normalized_name: name.toLowerCase(),
            default_category_id: null,
            primary_recipient_id: null,
            notes: null,
            is_active: true,
            created_at: TS,
            updated_at: TS,
            default_category_name: null,
            primary_bank_account: null,
            primary_recipient_name: null,
            alias_count: 0,
            links: [],
        },
        fields,
    );
}

/**
 * `POST /api/recipients`: `withCreateOutcome` adds `created` (true with a 201,
 * false with the 200 of an existing recipient).
 */
export function recipientCreated<T extends Row>(fields: T) {
    return merge({ ...recipientRow(fields), created: false }, fields);
}

/** `GET /api/recipients` body (always paginated). */
export function recipientsBody<T>(body: ListBody<T>) {
    return pageBody(body, 200);
}

/** A legacy category row: `SELECT *` plus `category_name` and `links`. */
export function categoryRow<T extends Row>(fields: T) {
    const general =
        typeof fields.general === "string" ? fields.general : "GENERAL";
    const detail = typeof fields.detail === "string" ? fields.detail : "DETAIL";
    const pathName =
        typeof fields.category_name === "string"
            ? fields.category_name
            : `${general}:${detail}`;
    return merge(
        {
            id: 1,
            general,
            detail,
            description: null,
            is_active: true,
            created_at: TS,
            updated_at: TS,
            parent_id: null,
            name: detail,
            hierarchy_only: false,
            legacy_compatible: true,
            path_name: pathName,
            category_name: pathName,
            links: [],
        },
        fields,
    );
}

/** `GET /api/categories` body; `limit`/`offset` only when paginated. */
export function categoriesBody<T>(body: ListBody<T>) {
    return { links: [], ...body, total: body.total ?? body.items.length };
}

/** One `mapNode` tree node. */
export function categoryNode<T extends Row>(fields: T) {
    const path = Array.isArray(fields.path)
        ? (fields.path as string[])
        : [typeof fields.name === "string" ? fields.name : "CATEGORY"];
    const id = typeof fields.id === "number" ? fields.id : 1;
    // Synthetic ancestor ids keep pathIds/parentId consistent with `path`.
    const pathIds = [...path.slice(0, -1).map((_, i) => 9000 + i), id];
    return merge(
        {
            id,
            name: path[path.length - 1],
            parentId: pathIds.length > 1 ? pathIds[pathIds.length - 2] : null,
            pathIds,
            path,
            category_name: path.join(":"),
            depth: path.length,
            description: null,
            is_active: true,
            hierarchyOnly: false,
            legacyCompatible: true,
        },
        fields,
    );
}

/** `GET /api/categories/tree` body: `{ items, total }`. */
export function categoryTreeBody<T>(body: ListBody<T>) {
    return { ...body, total: body.total ?? body.items.length };
}

/** A `recipient_match_patterns` row as `listPatternsForRecipient` selects it. */
export function recipientPatternRow<T extends Row>(fields: T) {
    return merge(
        {
            id: 1,
            pattern: "PATTERN",
            pattern_kind: "literal_prefix",
            case_sensitive: false,
            priority: 100,
            is_active: true,
            source: "user",
            notes: null,
            created_at: TS,
            updated_at: TS,
        },
        fields,
    );
}

/** `GET /api/recipients/:id/patterns` body: `{ items, total }`. */
export function recipientPatternsBody<T>(body: ListBody<T>) {
    return { ...body, total: body.total ?? body.items.length };
}

/** accountRepository's `COLUMNS` row plus the route's `links: []`. */
export function accountRow<T extends Row>(fields: T) {
    return merge(
        {
            id: 1,
            name: "ACCOUNT",
            display_name: null,
            institution: null,
            currency: "EUR",
            type: "checking",
            liquidity_class: "liquid",
            spendable: true,
            in_net_worth: true,
            tax_wrapper: "none",
            owner: "me",
            multi_currency_cash: false,
            has_cash_sleeve: true,
            funding_account_id: null,
            is_active: true,
            closed_at: null,
            created_at: TS,
            updated_at: TS,
            links: [],
        },
        fields,
    );
}

/**
 * One `accountService.list` item: the columns plus the balance enrichments.
 * The defaults model a single-currency account with transactions (an item
 * without `has_transactions` used to read as true): one currency partition,
 * which is also the reconciliation base, holding `computed_balance` in the
 * account's currency. An account without transactions has no partitions.
 */
export function accountListItem<T extends Row>(fields: T) {
    const { links: _links, ...columns } = accountRow(fields);
    const computed =
        typeof fields.computed_balance === "number"
            ? fields.computed_balance
            : 0;
    const baseBalance =
        typeof fields.reconcilable_balance === "number"
            ? fields.reconcilable_balance
            : computed;
    const baseCurrency =
        typeof fields.reconcilable_currency === "string"
            ? fields.reconcilable_currency
            : columns.currency;
    const hasTransactions = fields.has_transactions !== false;
    return merge(
        {
            has_transactions: hasTransactions,
            statement_balances: [],
            computed_balance: computed,
            balance_parts: hasTransactions
                ? [{ currency: baseCurrency, balance: baseBalance }]
                : [],
            balance_incomplete: false,
            unconverted_currencies: [],
            reconcilable_balance: baseBalance,
            reconcilable_currency: baseCurrency,
            drift: null,
        },
        columns,
    );
}

/** `GET /api/accounts` body; `limit`/`offset` only when paginated. */
export function accountsBody<T>(body: ListBody<T>) {
    return { links: [], ...body, total: body.total ?? body.items.length };
}
