import { describe, expect, it } from "vitest";
import { parsePortfolioPerformanceXml } from "../src/services/portfolioPerformanceXmlParser.js";
import {
  portfolioPerformanceXml,
  ppEvent,
} from "./fixtures/portfolioPerformanceSynthetic.js";

describe("bounded Portfolio Performance XML reference reader", () => {
  it("resolves current-node relative references, primitive fields, money scale, and portfolio shares scale", () => {
    const base = portfolioPerformanceXml({
      events: [ppEvent({ amount: "12.34", shares: "1.23456789" })],
    });
    const xml = base.replace(
      "<currencyCode>EUR</currencyCode></account>",
      '<currencyCode reference="../../../securities/security/currencyCode"/></account>',
    );
    const parsed = parsePortfolioPerformanceXml(xml);
    expect(parsed.accounts[0].currency).toBe("EUR");
    expect(parsed.events[0]).toMatchObject({
      amount: "12.34",
      shares: "1.23456789",
      referenceAccountId: "account-one",
    });
    expect(parsed.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("retains paired cash facts and validates trade identity without treating cash shares as position units", () => {
    const xml = portfolioPerformanceXml({
      events: [ppEvent({ type: "BUY", amount: "123", shares: "2" })],
    });
    expect(
      parsePortfolioPerformanceXml(xml).events[0].literal.pairedCash,
    ).toMatchObject({ type: "BUY", sharesMinor: "0", amountMinor: "12300" });
    expect(() =>
      parsePortfolioPerformanceXml(
        xml.replace(
          "<amount>12300</amount><shares>0",
          "<amount>12301</amount><shares>0",
        ),
      ),
    ).toThrow("paired trade cash");
  });
  it("resolves exact paired transfers across shared custody reference accounts", () => {
    const events = [
      ppEvent({ id: "out", type: "TRANSFER_OUT", pairId: "in" }),
      ppEvent({
        id: "in",
        type: "TRANSFER_IN",
        pairId: "out",
        portfolioId: "portfolio-two",
      }),
    ];
    const parsed = parsePortfolioPerformanceXml(
      portfolioPerformanceXml({ events }),
    );
    expect(parsed.events[0].literal.toTransactionId).toBe("in");
    expect(() =>
      parsePortfolioPerformanceXml(
        portfolioPerformanceXml({
          events: [events[0], { ...events[1], shares: "2" }],
        }),
      ),
    ).toThrow("transfer pair");
  });
  it.each([
    '<!DOCTYPE client [<!ENTITY external SYSTEM "file:///etc/passwd">]><client/>',
    "<client><securities>&unknown;</securities></client>",
    '<client><a reference="../b"/><b reference="../a"/></client>',
    '<client><a reference="../../missing"/></client>',
    '<?xml version="1.0" encoding="ISO-8859-1"?><client/>',
    "<client>" + "<n>".repeat(65) + "</n>".repeat(65) + "</client>",
  ])("rejects unsafe or unsupported XML graph %#", (xml) =>
    expect(() => parsePortfolioPerformanceXml(xml)).toThrow(),
  );
  it("rejects malformed calendar dates and out-of-range Java monetary integers", () => {
    expect(() =>
      parsePortfolioPerformanceXml(
        portfolioPerformanceXml({ events: [ppEvent({ date: "2025-02-30" })] }),
      ),
    ).toThrow("date");
    expect(() =>
      parsePortfolioPerformanceXml(
        portfolioPerformanceXml({
          events: [ppEvent({ amount: "92233720368547758.08" })],
        }),
      ),
    ).toThrow("money");
    expect(() =>
      parsePortfolioPerformanceXml(" ".repeat(10 * 1024 * 1024 + 1)),
    ).toThrow("10 MiB");
  });
});
