/**
 * Report-section catalog for the PDF export dialog.
 *
 * Hand-mirrors the backend's single source of truth in
 * apps/node-backend/src/services/reports/sectionCatalog.js
 * (FINANCIAL/PORTFOLIO/TAX_SECTION_CATALOG): same IDs, same order. The backend
 * silently drops unknown section IDs, so a typo here would silently omit a
 * section from the PDF — apps/node-backend/tests/reportSectionCatalog.test.js
 * imports this module and fails when the two sides drift.
 *
 * This module must stay a dependency-free data leaf (types + constants only)
 * so the backend test suite can import it without pulling in React.
 */

export type ReportType = 'financial' | 'portfolio' | 'tax';

export interface SectionDef {
  id: string;
  labelKey: string;
}

export const FINANCIAL_SECTIONS: SectionDef[] = [
  { id: 'executiveSummary', labelKey: 'export.section.executiveSummary' },
  { id: 'cashflowTrend',    labelKey: 'export.section.cashflowTrend'    },
  { id: 'categoryBreakdown',labelKey: 'export.section.categoryBreakdown'},
  { id: 'topRecipients',    labelKey: 'export.section.topRecipients'    },
  { id: 'bankBalances',     labelKey: 'export.section.bankBalances'     },
  { id: 'rollingAverages',  labelKey: 'export.section.rollingAverages'  },
  { id: 'plannedOutlook',   labelKey: 'export.section.plannedOutlook'   },
];

export const PORTFOLIO_SECTIONS: SectionDef[] = [
  { id: 'portfolioExecutiveSummary', labelKey: 'export.section.portfolioExecutiveSummary' },
  { id: 'portfolioAllocation',       labelKey: 'export.section.portfolioAllocation'       },
  { id: 'topHoldings',               labelKey: 'export.section.topHoldings'               },
  { id: 'performanceTrend',          labelKey: 'export.section.performanceTrend'          },
  { id: 'assetClassDetail',          labelKey: 'export.section.assetClassDetail'          },
  { id: 'dividendIncome',            labelKey: 'export.section.dividendIncome'            },
];

export const TAX_SECTIONS: SectionDef[] = [
  { id: 'taxExecutiveSummary',  labelKey: 'export.section.taxExecutiveSummary'  },
  { id: 'taxTypeBreakdown',     labelKey: 'export.section.taxTypeBreakdown'     },
  { id: 'taxByAssetClass',      labelKey: 'export.section.taxByAssetClass'      },
  { id: 'taxMonthlyTrend',      labelKey: 'export.section.taxMonthlyTrend'      },
  { id: 'topInvestmentsByCost', labelKey: 'export.section.topInvestmentsByCost' },
  { id: 'feeBreakdown',         labelKey: 'export.section.feeBreakdown'         },
  { id: 'belgianRulesSummary',  labelKey: 'export.section.belgianRulesSummary'  },
];

export const SECTIONS_BY_TYPE: Record<ReportType, SectionDef[]> = {
  financial: FINANCIAL_SECTIONS,
  portfolio: PORTFOLIO_SECTIONS,
  tax:       TAX_SECTIONS,
};
