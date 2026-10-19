import { describe, expect, it } from "vitest";
import { getBrokerAccountMetrics } from "../brokerAccountMetrics";
import { asAccountId, asCurrencyCode } from "@vision/types/brands";

describe("getBrokerAccountMetrics", () => {
    it("separates position value from total broker profit and loss", () => {
        const metrics = getBrokerAccountMetrics(
            {
                currency: asCurrencyCode("EUR"),
                computed_at: "2026-09-08T00:00:00Z",
                totals: {} as never,
                summaries: [],
                byAssetClass: [],
                byAssetGroup: [],
                byAccount: [
                    {
                        account_id: asAccountId(4),
                        assignment: "account",
                        contribution_kind: "position",
                        oversold: false,
                        currentValue: 1200,
                        totalInvested: 1000,
                        realizedGain: 50,
                        unrealizedGain: 200,
                        gainLoss: 250,
                    },
                    {
                        account_id: asAccountId(4),
                        assignment: "account",
                        contribution_kind: "non_position",
                        oversold: false,
                        currentValue: 0,
                        totalInvested: 0,
                        realizedGain: 0,
                        unrealizedGain: 0,
                        gainLoss: 25,
                    },
                    {
                        account_id: asAccountId(8),
                        assignment: "account",
                        contribution_kind: "position",
                        oversold: true,
                        currentValue: 900,
                        totalInvested: 800,
                        realizedGain: 0,
                        unrealizedGain: 100,
                        gainLoss: 100,
                    },
                ],
            },
            asAccountId(4),
        );
        expect(metrics).toEqual({
            holdingsValue: 1200,
            gainLoss: 275,
            oversold: false,
            hasPosition: true,
        });
    });

    it("distinguishes a loaded account with no position from loading", () => {
        expect(getBrokerAccountMetrics(undefined, asAccountId(4))).toBeUndefined();
        expect(
            getBrokerAccountMetrics(
                {
                    currency: asCurrencyCode("EUR"),
                    computed_at: "2026-09-08T00:00:00Z",
                    totals: {} as never,
                    summaries: [],
                    byAssetClass: [],
                    byAssetGroup: [],
                    byAccount: [],
                },
                asAccountId(4),
            ),
        ).toEqual({
            holdingsValue: 0,
            gainLoss: 0,
            oversold: false,
            hasPosition: false,
        });
    });
});
