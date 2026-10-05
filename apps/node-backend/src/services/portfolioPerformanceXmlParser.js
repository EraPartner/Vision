/** Bounded reader for Portfolio Performance's XStream XML object graph. */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { SaxesParser } from "saxes";
import { ValidationError } from "../middleware/errorHandler.js";
import { toDecimal } from "../lib/money.js";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_NODES = 300000;
const MAX_DEPTH = 64;
const fail = (message) =>
  new ValidationError(`Portfolio Performance XML: ${message}`);
const child = (node, tag) => node?.children.find((item) => item.tag === tag);

function xmlTree(xml) {
  if (typeof xml !== "string" || Buffer.byteLength(xml, "utf8") > MAX_BYTES)
    throw fail("file exceeds the 10 MiB limit");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))
    throw fail("DOCTYPE and entity declarations are forbidden");
  const encoding = /<\?xml\s+[^?]*encoding\s*=\s*["']([^"']+)["']/i.exec(
    xml,
  )?.[1];
  if (encoding && !/^utf-?8$/i.test(encoding))
    throw fail("only UTF-8 is supported");
  const parser = new SaxesParser({ xmlns: false });
  const stack = [];
  /** @type {any} */
  let root;
  let count = 0;
  parser.on("doctype", () => {
    throw fail("DOCTYPE is forbidden");
  });
  parser.on("error", () => {
    throw fail("malformed XML or an unsupported entity");
  });
  parser.on("opentag", (tag) => {
    if (++count > MAX_NODES || stack.length >= MAX_DEPTH)
      throw fail("node or nesting limit exceeded");
    const node = {
      tag: tag.name,
      attributes: tag.attributes,
      text: "",
      children: [],
      parent: stack.at(-1),
    };
    if (node.parent) node.parent.children.push(node);
    else if (root) throw fail("multiple root elements");
    else root = node;
    stack.push(node);
  });
  const append = (value) => {
    const node = stack.at(-1);
    if (node) {
      node.text += value;
      if (node.text.length > 100000) throw fail("text node limit exceeded");
    }
  };
  parser.on("text", append);
  parser.on("cdata", append);
  parser.on("closetag", () => {
    stack.pop();
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw fail("malformed XML");
  }
  if (root?.tag !== "client") throw fail("expected a client document");
  return root;
}

/** XStream's relative paths begin at the referencing node, including ../ steps. */
function resolver(root) {
  return function resolve(start) {
    /** @type {any} */
    let node = start;
    const seen = new Set();
    while (node?.attributes.reference) {
      if (seen.has(node) || seen.size >= 64)
        throw fail("reference loop or chain limit exceeded");
      seen.add(node);
      const path = String(node.attributes.reference);
      if (path.length > 4096 || path.split("/").length > 128)
        throw fail("reference path limit exceeded");
      let current = path.startsWith("/") ? root : node;
      const parts = path.split("/");
      if (path.startsWith("/")) {
        parts.shift();
        if (parts[0] === root.tag) parts.shift();
      }
      for (const part of parts) {
        if (part === ".") continue;
        if (part === "..") current = current?.parent;
        else {
          const match = /^([A-Za-z_][\w.-]*)(?:\[([1-9]\d*)\])?$/.exec(part);
          if (!match) throw fail("unsupported reference path");
          current = current?.children.filter((item) => item.tag === match[1])[
            Number(match[2] || 1) - 1
          ];
        }
        if (!current) throw fail("reference target is missing");
      }
      node = current;
    }
    return node;
  };
}

function integer(value, label) {
  if (!/^\d{1,19}$/.test(value) || toDecimal(value).gt("9223372036854775807"))
    throw fail(`invalid ${label}`);
  return toDecimal(value);
}
function money(node) {
  if (!node) return undefined;
  const currency = String(node.attributes.currency || "");
  const minor = String(node.attributes.amount || "");
  if (!/^[A-Z]{3}$/.test(currency)) throw fail("invalid money currency");
  return {
    currency,
    amount: integer(minor, "money amount").div(100).toFixed(),
    minor,
  };
}
function date(value) {
  const day = value.slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ||
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
  )
    throw fail("invalid transaction date");
  return day;
}

export function parsePortfolioPerformanceXml(xml) {
  const root = xmlTree(xml);
  const resolve = resolver(root);
  const text = (node, tag) => resolve(child(node, tag))?.text.trim() || "";
  const children = (node, tag) => resolve(child(node, tag))?.children || [];
  // Resolve all reference chains, including those not needed for transactions.
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    resolve(node);
    pending.push(...node.children);
  }
  const sourceHash = createHash("sha256").update(xml, "utf8").digest("hex");
  const securities = new Map();
  for (const entry of children(root, "securities")) {
    const node = resolve(entry);
    const id = text(node, "uuid");
    if (!id || securities.has(id))
      throw fail("missing or duplicate security ID");
    securities.set(id, {
      id,
      name: text(node, "name"),
      isin: text(node, "isin"),
      ticker: text(node, "tickerSymbol"),
      currency: text(node, "currencyCode"),
    });
  }
  const accounts = new Map();
  for (const entry of children(root, "accounts")) {
    const node = resolve(entry);
    const id = text(node, "uuid");
    if (!id || accounts.has(id)) throw fail("missing or duplicate account ID");
    accounts.set(id, {
      id,
      name: text(node, "name"),
      currency: text(node, "currencyCode"),
      node,
    });
  }
  const portfolios = new Map();
  for (const entry of children(root, "portfolios")) {
    const node = resolve(entry);
    const id = text(node, "uuid");
    if (!id || portfolios.has(id))
      throw fail("missing or duplicate portfolio ID");
    const referenceAccountId = text(
      resolve(child(node, "referenceAccount")),
      "uuid",
    );
    if (!accounts.has(referenceAccountId))
      throw fail("portfolio reference account is missing");
    portfolios.set(id, {
      id,
      name: text(node, "name"),
      referenceAccountId,
      node,
    });
  }
  const events = [];
  const seen = new Set();
  for (const portfolio of portfolios.values())
    for (const entry of children(portfolio.node, "transactions")) {
      const node = resolve(entry);
      const id = text(node, "uuid");
      if (!id || seen.has(id))
        throw fail("missing or duplicate portfolio transaction ID");
      seen.add(id);
      const securityId = text(resolve(child(node, "security")), "uuid");
      if (!securities.has(securityId))
        throw fail("transaction security is missing");
      const type = text(node, "type");
      if (
        ![
          "BUY",
          "SELL",
          "DELIVERY_INBOUND",
          "DELIVERY_OUTBOUND",
          "TRANSFER_IN",
          "TRANSFER_OUT",
        ].includes(type)
      )
        throw fail("unsupported portfolio transaction type");
      const sharesMinor = text(node, "shares");
      const amountMinor = text(node, "amount");
      const currency = text(node, "currencyCode");
      if (!/^[A-Z]{3}$/.test(currency))
        throw fail("invalid transaction currency");
      const units = children(node, "units").map((entry) => {
        const unit = resolve(entry);
        const kind = String(unit.attributes.type || "");
        if (!["GROSS_VALUE", "FEE", "TAX"].includes(kind))
          throw fail("unsupported transaction unit type");
        const exchangeRate = text(unit, "exchangeRate");
        if (
          exchangeRate &&
          (exchangeRate.length > 100 ||
            !/^\d+(?:\.\d+)?$/.test(exchangeRate) ||
            !toDecimal(exchangeRate).gt(0))
        )
          throw fail("invalid exchange rate");
        return {
          type: kind,
          amount: money(resolve(child(unit, "amount"))),
          forex: money(resolve(child(unit, "forex"))),
          exchangeRate: exchangeRate || undefined,
        };
      });
      const cross = resolve(child(node, "crossEntry"));
      const fromPortfolioId = text(
        resolve(child(cross, "portfolioFrom")),
        "uuid",
      );
      const toPortfolioId = text(resolve(child(cross, "portfolioTo")), "uuid");
      const fromTransactionId = text(
        resolve(child(cross, "transactionFrom")),
        "uuid",
      );
      const toTransactionId = text(
        resolve(child(cross, "transactionTo")),
        "uuid",
      );
      const pairedCashAccountId = text(
        resolve(child(cross, "account")),
        "uuid",
      );
      const pairedCashTransactionId = text(
        resolve(child(cross, "accountTransaction")),
        "uuid",
      );
      const cash = resolve(child(cross, "accountTransaction"));
      const pairedCash = cash
        ? {
            transactionId: pairedCashTransactionId,
            accountId: pairedCashAccountId,
            type: text(cash, "type"),
            date: text(cash, "date"),
            currency: text(cash, "currencyCode"),
            amountMinor: text(cash, "amount"),
            sharesMinor: text(cash, "shares"),
            securityId: text(resolve(child(cash, "security")), "uuid"),
          }
        : undefined;
      if (
        ["BUY", "SELL"].includes(type) &&
        (!pairedCash ||
          !accounts.has(pairedCash.accountId) ||
          pairedCash.type !== type ||
          date(pairedCash.date) !== date(text(node, "date")) ||
          pairedCash.currency !== currency ||
          !integer(pairedCash.amountMinor, "paired cash amount").eq(
            integer(amountMinor, "transaction money"),
          ) ||
          pairedCash.securityId !== securityId ||
          text(resolve(child(cross, "portfolioTransaction")), "uuid") !== id ||
          text(resolve(child(cross, "portfolio")), "uuid") !== portfolio.id)
      )
        throw fail("paired trade cash facts are inconsistent");
      const literal = {
        transactionId: id,
        date: text(node, "date"),
        type,
        note: text(node, "note") || undefined,
        currency,
        amountMinor,
        sharesMinor,
        securityId,
        units,
        reference: node.attributes.reference || undefined,
        pairedCashAccountId: pairedCashAccountId || undefined,
        pairedCashTransactionId: pairedCashTransactionId || undefined,
        pairedCash,
        fromPortfolioId: fromPortfolioId || undefined,
        toPortfolioId: toPortfolioId || undefined,
        fromTransactionId: fromTransactionId || undefined,
        toTransactionId: toTransactionId || undefined,
      };
      events.push({
        id,
        portfolioId: portfolio.id,
        referenceAccountId: portfolio.referenceAccountId,
        securityId,
        type,
        date: date(literal.date),
        currency,
        amount: integer(amountMinor, "transaction money").div(100).toFixed(),
        shares: integer(sharesMinor, "share quantity")
          .div("100000000")
          .toFixed(),
        units,
        literal,
      });
    }
  const eventMap = new Map(events.map((event) => [event.id, event]));
  for (const event of events)
    if (["TRANSFER_IN", "TRANSFER_OUT"].includes(event.type)) {
      const literal = event.literal;
      const from = eventMap.get(literal.fromTransactionId);
      const to = eventMap.get(literal.toTransactionId);
      if (
        !from ||
        !to ||
        from.type !== "TRANSFER_OUT" ||
        to.type !== "TRANSFER_IN" ||
        from.portfolioId !== literal.fromPortfolioId ||
        to.portfolioId !== literal.toPortfolioId ||
        from.securityId !== to.securityId ||
        from.date !== to.date ||
        !toDecimal(from.shares).eq(to.shares)
      )
        throw fail("portfolio transfer pair is inconsistent");
    }
  return {
    sourceHash,
    securities: [...securities.values()],
    accounts: [...accounts.values()].map(({ node: _node, ...value }) => value),
    portfolios: [...portfolios.values()].map(
      ({ node: _node, ...value }) => value,
    ),
    events,
  };
}

export async function readPortfolioPerformanceXml(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_BYTES)
    throw fail("file exceeds the 10 MiB limit or is not a file");
  const data = await readFile(path);
  let xml;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw fail("invalid UTF-8");
  }
  return parsePortfolioPerformanceXml(xml);
}
