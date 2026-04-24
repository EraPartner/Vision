/**
 * Section renderer: Bank Balances.
 *
 * Shows current balance per account plus total net position.
 */

import {
  escapeHtml,
  fmtCurrency,
  fmtDate,
  signClass,
} from '../sectionHelpers.js';

/**
 * @param {{ banks: object | null }} data
 * @param {{ currency: string }} opts
 * @returns {string}
 */
export function renderBankBalances(data, { currency }) {
  const accounts = data.banks?.accounts ?? [];
  const totalNetPosition = data.banks?.total_net_position ?? 0;

  if (!accounts.length) {
    return `
      <div class="page page-break">
        <div class="section-title">Bank Balances</div>
        <div class="section-subtitle">Current balance per account</div>
        <hr class="section-divider">
        <div class="empty-notice">No bank balance data available.</div>
      </div>`;
  }

  // Sort accounts: highest absolute balance first
  const sorted = [...accounts].sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

  const accountCards = sorted.map(acc => {
    const sc = signClass(acc.balance);
    const lastTxn = acc.last_transaction ? fmtDate(acc.last_transaction) : '—';
    const txCount = acc.transaction_count ?? 0;
    return `
      <div class="account-card">
        <div class="account-name">${escapeHtml(acc.bank_account ?? 'Unknown')}</div>
        <div class="account-balance ${sc}">${escapeHtml(fmtCurrency(acc.balance, currency))}</div>
        <div class="account-meta">${txCount.toLocaleString()} txns · last ${escapeHtml(lastTxn)}</div>
      </div>`;
  }).join('');

  const netSc = signClass(totalNetPosition);

  return `
    <div class="page page-break">
      <div class="section-title">Bank Balances</div>
      <div class="section-subtitle">Current balance per account</div>
      <hr class="section-divider">
      <div class="account-grid">${accountCards}</div>
      <div class="stat-row" style="border-top:1px solid hsl(var(--border));padding-top:12px;margin-top:4px">
        <span class="stat-label" style="font-weight:700;color:hsl(var(--text))">Total Net Position</span>
        <span class="stat-value ${netSc}" style="font-size:18px">${escapeHtml(fmtCurrency(totalNetPosition, currency))}</span>
      </div>
    </div>`;
}
