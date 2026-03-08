import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type {
  Investment, PortfolioTransaction, InvestmentSummary, AssetClass,
} from '@/types/portfolio';

const STORAGE_KEY_INVESTMENTS = 'portfolio_investments';
const STORAGE_KEY_TRANSACTIONS = 'portfolio_transactions';

// ---------- tiny reactive store over localStorage ----------
let listeners: Array<() => void> = [];
function emitChange() { listeners.forEach((l) => l()); }
function subscribe(cb: () => void) { listeners.push(cb); return () => { listeners = listeners.filter((l) => l !== cb); }; }

function readList<T>(key: string): T[] {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
function writeList<T>(key: string, data: T[]) {
  localStorage.setItem(key, JSON.stringify(data));
  emitChange();
}

function uid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }

// ---------- hook ----------
export function usePortfolio() {
  const snapshot = useSyncExternalStore(subscribe, () =>
    localStorage.getItem(STORAGE_KEY_INVESTMENTS) + '|' + localStorage.getItem(STORAGE_KEY_TRANSACTIONS)
  );

  const investments = useMemo(() => readList<Investment>(STORAGE_KEY_INVESTMENTS), [snapshot]);
  const transactions = useMemo(() => readList<PortfolioTransaction>(STORAGE_KEY_TRANSACTIONS), [snapshot]);

  // ---- CRUD investments ----
  const addInvestment = useCallback((data: Omit<Investment, 'id' | 'createdAt' | 'updatedAt'>) => {
    const inv: Investment = { ...data, id: uid(), createdAt: now(), updatedAt: now() };
    writeList(STORAGE_KEY_INVESTMENTS, [...readList<Investment>(STORAGE_KEY_INVESTMENTS), inv]);
    return inv;
  }, []);

  const updateInvestment = useCallback((id: string, patch: Partial<Investment>) => {
    const list = readList<Investment>(STORAGE_KEY_INVESTMENTS);
    writeList(STORAGE_KEY_INVESTMENTS, list.map((i) => (i.id === id ? { ...i, ...patch, updatedAt: now() } : i)));
  }, []);

  const deleteInvestment = useCallback((id: string) => {
    writeList(STORAGE_KEY_INVESTMENTS, readList<Investment>(STORAGE_KEY_INVESTMENTS).filter((i) => i.id !== id));
    writeList(STORAGE_KEY_TRANSACTIONS, readList<PortfolioTransaction>(STORAGE_KEY_TRANSACTIONS).filter((t) => t.investmentId !== id));
  }, []);

  // ---- CRUD transactions ----
  const addTransaction = useCallback((data: Omit<PortfolioTransaction, 'id'>) => {
    const txn: PortfolioTransaction = { ...data, id: uid() };
    writeList(STORAGE_KEY_TRANSACTIONS, [...readList<PortfolioTransaction>(STORAGE_KEY_TRANSACTIONS), txn]);
    return txn;
  }, []);

  const deleteTransaction = useCallback((id: string) => {
    writeList(STORAGE_KEY_TRANSACTIONS, readList<PortfolioTransaction>(STORAGE_KEY_TRANSACTIONS).filter((t) => t.id !== id));
  }, []);

  // ---- computed summaries ----
  const summaries: InvestmentSummary[] = useMemo(() => {
    return investments.map((inv) => {
      const txns = transactions.filter((t) => t.investmentId === inv.id);
      const buys = txns.filter((t) => t.type === 'buy');
      const sells = txns.filter((t) => t.type === 'sell');
      const totalBuyUnits = buys.reduce((s, t) => s + (t.units ?? 0), 0);
      const totalSellUnits = sells.reduce((s, t) => s + (t.units ?? 0), 0);
      const totalUnits = totalBuyUnits - totalSellUnits;
      const totalInvested = buys.reduce((s, t) => s + t.amount, 0) - sells.reduce((s, t) => s + t.amount, 0);
      const totalFees = txns.filter((t) => t.type === 'fee').reduce((s, t) => s + t.amount, 0)
        + txns.reduce((s, t) => s + (t.fees ?? 0), 0);
      const totalTaxes = txns.filter((t) => t.type === 'tax').reduce((s, t) => s + t.amount, 0)
        + txns.reduce((s, t) => s + (t.taxes ?? 0), 0);
      const totalDividends = txns.filter((t) => t.type === 'dividend').reduce((s, t) => s + t.amount, 0);
      const totalInterest = txns.filter((t) => t.type === 'interest').reduce((s, t) => s + t.amount, 0);
      const totalRent = txns.filter((t) => t.type === 'rent_income').reduce((s, t) => s + t.amount, 0);
      const totalIncome = totalDividends + totalInterest + totalRent;

      // Current value: for unit-based assets use price * units, otherwise use totalInvested + appreciation
      let currentValue: number;
      if (['stock', 'etf', 'crypto'].includes(inv.assetClass)) {
        currentValue = (inv.currentPrice ?? 0) * totalUnits;
      } else if (inv.assetClass === 'real_estate') {
        const appreciations = txns.filter((t) => t.type === 'appreciation').reduce((s, t) => s + t.amount, 0);
        currentValue = totalInvested + appreciations;
      } else {
        currentValue = totalInvested + totalInterest;
      }

      const gainLoss = currentValue - totalInvested - totalFees - totalTaxes + totalIncome;
      const gainLossPercent = totalInvested > 0 ? (gainLoss / totalInvested) * 100 : 0;

      return {
        ...inv,
        totalUnits,
        totalInvested: Math.abs(totalInvested),
        totalFees,
        totalTaxes,
        totalDividends,
        totalIncome,
        currentValue,
        gainLoss,
        gainLossPercent,
        transactions: txns.sort((a, b) => b.date.localeCompare(a.date)),
      };
    });
  }, [investments, transactions]);

  const byAssetClass = useCallback((cls: AssetClass | AssetClass[]) => {
    const classes = Array.isArray(cls) ? cls : [cls];
    return summaries.filter((s) => classes.includes(s.assetClass));
  }, [summaries]);

  const totalPortfolioValue = useMemo(() => summaries.reduce((s, i) => s + i.currentValue, 0), [summaries]);
  const totalGainLoss = useMemo(() => summaries.reduce((s, i) => s + i.gainLoss, 0), [summaries]);

  return {
    investments, transactions, summaries,
    addInvestment, updateInvestment, deleteInvestment,
    addTransaction, deleteTransaction,
    byAssetClass, totalPortfolioValue, totalGainLoss,
  };
}
