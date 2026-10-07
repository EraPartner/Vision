import { toDecimal } from "../../src/lib/money.ts";

const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
const minor = (value, factor) => toDecimal(value).times(factor).toFixed(0);

/** Synthetic object graph only; no copied personal statement data. */
export function portfolioPerformanceXml({
  events = [],
  portfolios = [
    { id: "portfolio-one", accountId: "account-one" },
    { id: "portfolio-two", accountId: "account-two" },
  ],
  securities = [
    {
      id: "security-eth",
      ticker: "ETH",
      name: "Synthetic Ether",
      currency: "EUR",
    },
  ],
} = {}) {
  const accounts = [
    ...new Set(portfolios.map((portfolio) => portfolio.accountId)),
  ];
  const path = (id) => {
    const event = events.find((item) => item.id === id);
    const portfolioIndex = portfolios.findIndex(
      (portfolio) => portfolio.id === event.portfolioId,
    );
    const transactionIndex = events
      .filter((item) => item.portfolioId === event.portfolioId)
      .findIndex((item) => item.id === id);
    return `/client/portfolios/portfolio[${portfolioIndex + 1}]/transactions/portfolio-transaction[${transactionIndex + 1}]`;
  };
  const securityPath = (id) =>
    `/client/securities/security[${securities.findIndex((item) => item.id === id) + 1}]`;
  const portfolioPath = (id) =>
    `/client/portfolios/portfolio[${portfolios.findIndex((item) => item.id === id) + 1}]`;
  const transaction = (event) => {
    const currency = event.currency || "EUR";
    const shares = minor(event.shares ?? 1, "100000000");
    const amount = minor(event.amount ?? "0.01", 100);
    const securityId = event.securityId || "security-eth";
    const day = event.date || "2025-01-01";
    const units = (event.units || [])
      .map(
        (unit) =>
          `<unit type="${unit.type}"><amount currency="${unit.amount.currency}" amount="${minor(unit.amount.amount, 100)}"/>${unit.forex ? `<forex currency="${unit.forex.currency}" amount="${minor(unit.forex.amount, 100)}"/>` : ""}${unit.exchangeRate ? `<exchangeRate>${esc(unit.exchangeRate)}</exchangeRate>` : ""}</unit>`,
      )
      .join("");
    const portfolio = portfolios.find((item) => item.id === event.portfolioId);
    let cross = "";
    if (["BUY", "SELL"].includes(event.type))
      cross = `<crossEntry class="buysell"><portfolio reference="${portfolioPath(event.portfolioId)}"/><portfolioTransaction reference="${path(event.id)}"/><account reference="/client/accounts/account[${accounts.indexOf(portfolio.accountId) + 1}]"/><accountTransaction><uuid>cash-${esc(event.id)}</uuid><type>${event.type}</type><date>${day}T00:00</date><currencyCode>${currency}</currencyCode><amount>${amount}</amount><shares>0</shares><security reference="${securityPath(securityId)}"/></accountTransaction></crossEntry>`;
    if (["TRANSFER_IN", "TRANSFER_OUT"].includes(event.type)) {
      const other = events.find((item) => item.id === event.pairId);
      const from = event.type === "TRANSFER_OUT" ? event : other;
      const to = event.type === "TRANSFER_IN" ? event : other;
      cross = `<crossEntry class="portfolio-transfer"><portfolioFrom reference="${portfolioPath(from.portfolioId)}"/><transactionFrom reference="${path(from.id)}"/><portfolioTo reference="${portfolioPath(to.portfolioId)}"/><transactionTo reference="${path(to.id)}"/></crossEntry>`;
    }
    return `<portfolio-transaction><uuid>${esc(event.id)}</uuid><date>${day}T00:00</date><currencyCode>${currency}</currencyCode><amount>${amount}</amount><security reference="${securityPath(securityId)}"/><shares>${shares}</shares><type>${event.type}</type><units>${units}</units>${cross}</portfolio-transaction>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?><client><securities>${securities.map((security) => `<security><uuid>${esc(security.id)}</uuid><name>${esc(security.name)}</name><tickerSymbol>${esc(security.ticker)}</tickerSymbol><currencyCode>${security.currency}</currencyCode></security>`).join("")}</securities><accounts>${accounts.map((id) => `<account><uuid>${esc(id)}</uuid><name>Synthetic account</name><currencyCode>EUR</currencyCode></account>`).join("")}</accounts><portfolios>${portfolios
    .map(
      (portfolio) =>
        `<portfolio><uuid>${esc(portfolio.id)}</uuid><name>Synthetic portfolio</name><referenceAccount reference="/client/accounts/account[${accounts.indexOf(portfolio.accountId) + 1}]"/><transactions>${events
          .filter((event) => event.portfolioId === portfolio.id)
          .map(transaction)
          .join("")}</transactions></portfolio>`,
    )
    .join("")}</portfolios></client>`;
}

export const ppEvent = (over = {}) => ({
  id: "reference-one",
  portfolioId: "portfolio-one",
  securityId: "security-eth",
  type: "DELIVERY_INBOUND",
  date: "2025-01-01",
  shares: "1",
  amount: "0.01",
  currency: "EUR",
  ...over,
});
