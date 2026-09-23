// ============================================================================
// src/utils/unifiedTxs.ts
// Pure transaction-history model shared by the investor dashboard.
//
// buildUnifiedTxs() merges the five sources returned by
// GET /investor/transactions (ledger, walletTransactions, withdrawals,
// investments, payouts) into ONE deduplicated history. Dedup rules matter:
// the backend deliberately writes overlapping bookkeeping records for the
// same money movement, and rendering every source produced duplicate rows
// (every wallet funding showed twice; every investment showed three times).
//
// Kept as a pure function so vitest can pin the dedup contract.
// ============================================================================

export type TransactionData = {
  payouts?: Array<Record<string, unknown>>;
  investments?: Array<Record<string, unknown>>;
  ledger?: Array<Record<string, unknown>>;
  walletTransactions?: Array<Record<string, unknown>>;
  withdrawals?: Array<Record<string, unknown>>;
};

export type UnifiedTx = {
  id: string;
  kind: "FUNDING" | "INVESTMENT_LOCK" | "INVESTMENT_RETURN" | "INVESTMENT" | "PAYOUT" | "DEPOSIT" | "FEE" | "OTHER";
  direction: "CREDIT" | "DEBIT";
  amountMinor: number;
  label: string;
  narration?: string;
  referenceId?: string;
  createdAt: string;
  balanceAfterMinor?: number;
  status?: string;
  raw: Record<string, unknown>;
};

// Normalize any provider/store status string for display (e.g.
// "PENDING_PROVIDER_CONFIRMATION" -> "PENDING PROVIDER CONFIRMATION").
export function txStatus(raw: unknown): string | undefined {
  if (raw == null || raw === "") return undefined;
  return String(raw).toUpperCase().replace(/_/g, " ");
}

// Invalid timestamps (missing/legacy rows) must not poison the list sort with
// NaN comparisons — clamp them to 0.
export function safeTxTime(value: string | undefined): number {
  const t = new Date(value ?? "").getTime();
  return Number.isFinite(t) ? t : 0;
}

export const TX_STATUS_TONES: Array<{ tone: "emerald" | "amber" | "red" | "slate"; match: string[] }> = [
  { tone: "emerald", match: ["SUCCESSFUL", "COMPLETED", "ACTIVE", "PAID OUT", "VERIFIED", "MATURED"] },
  { tone: "amber", match: ["PENDING", "PROCESSING", "LIQUIDITY REQUESTED", "LIQUIDITY APPROVED", "MATURITY PENDING", "PAYOUT PENDING", "PENDING REVIEW", "PENDING APPROVAL", "UNDER REVIEW"] },
  { tone: "red", match: ["FAILED", "REJECTED", "REVERSED", "CANCELLED", "DISPUTED", "DEFAULTED", "PAYOUT FAILED", "WRITTEN OFF", "PROVIDER NOT CONFIGURED"] },
];

export function txStatusTone(status?: string): "emerald" | "amber" | "red" | "slate" {
  if (!status) return "slate";
  for (const { tone, match } of TX_STATUS_TONES) {
    if (match.some((m) => status === m || status.startsWith(m))) return tone;
  }
  return "slate";
}

export function buildUnifiedTxs(data: TransactionData | null): UnifiedTx[] {
  const out: UnifiedTx[] = [];
  if (!data) return out;
  // Withdrawal records first: they carry the LIVE transfer status
  // (PROCESSING -> SUCCESSFUL/FAILED). Used both for first-class rows below and
  // to upgrade the matching WITHDRAWAL_INITIATED ledger rows (which would
  // otherwise render as an eternal "PROCESSING" entry even after the money
  // actually arrived in the investor's bank account).
  const withdrawalById = new Map<string, Record<string, unknown>>();
  (data.withdrawals || []).forEach((w: Record<string, unknown>) => {
    if (w && typeof w.id === "string") withdrawalById.set(w.id, w);
  });
  // Cross-source dedup indexes. A settled funding produces TWO records for the
  // same money — the original DEPOSIT wallet transaction (created when the
  // checkout started, carries the LIVE status) and a FUNDING ledger row
  // (written once at settlement, referenceId = the deposit tx id). Rendering
  // both made every wallet funding appear TWICE in the history.
  const walletTxById = new Map<string, Record<string, unknown>>();
  const walletTxByRef = new Map<string, Record<string, unknown>>();
  (data.walletTransactions || []).forEach((tx: Record<string, unknown>) => {
    if (tx && typeof tx.id === "string") walletTxById.set(tx.id, tx);
    if (tx && typeof tx.txRef === "string") walletTxByRef.set(tx.txRef, tx);
  });
  // Same story for investments: the first-class investment rows below already
  // carry plan name + live status, so the INVESTMENT_LOCK ledger row and the
  // INVESTMENT wallet transaction are pure duplicates.
  const investmentIds = new Set<string>();
  (data.investments || []).forEach((inv: Record<string, unknown>) => {
    if (inv && typeof inv.id === "string") investmentIds.add(inv.id);
  });
  (data.ledger || []).forEach((entry: any) => {
    const entryType = String(entry.entryType || "");
    // Bookkeeping marker (always ₦0) — the real movement is on the
    // WITHDRAWAL_INITIATED row and the withdrawal record itself.
    if (/WITHDRAWAL_SETTLEMENT/.test(entryType) && Number(entry.amountMinor ?? 0) === 0) return;
    // DEDUP (funding): the FUNDING ledger row duplicates the DEPOSIT wallet
    // transaction — skip it when the deposit row exists (by tx id or txRef).
    if (/^FUNDING$/.test(entryType)) {
      const meta = (entry.metadata ?? {}) as Record<string, unknown>;
      const duplicated =
        (entry.referenceId && walletTxById.has(String(entry.referenceId))) ||
        (meta.txRef && walletTxByRef.has(String(meta.txRef)));
      if (duplicated) return;
    }
    // DEDUP (investment): the first-class investment row below already
    // renders the position — skip the INVESTMENT_LOCK bookkeeping row.
    if (/INVESTMENT_LOCK/.test(entryType) && entry.referenceId && investmentIds.has(String(entry.referenceId))) return;
    const direction: "CREDIT" | "DEBIT" = entry.direction === "CREDIT" ? "CREDIT" : entry.direction === "DEBIT" ? "DEBIT" : (["INVESTOR_FUNDING", "INVESTMENT_RETURN", "DEPOSIT_CREDIT", "FUNDING"].some(k => entryType.includes(k)) ? "CREDIT" : "DEBIT");
    let kind: UnifiedTx["kind"] = "OTHER";
    if (/FUNDING|DEPOSIT/.test(entryType)) kind = "FUNDING";
    else if (/INVESTMENT.*LOCK|INVESTMENT_DEBIT/.test(entryType)) kind = "INVESTMENT_LOCK";
    else if (/INVESTMENT.*RETURN|INVESTMENT_CREDIT|MATURITY/.test(entryType)) kind = "INVESTMENT_RETURN";
    else if (/PAYOUT|WITHDRAWAL/.test(entryType)) kind = "PAYOUT";
    else if (/FEE/.test(entryType)) kind = "FEE";
    // Ledger entries are bookkeeping records: settled by definition, but
    // initiated withdrawals inherit the LIVE withdrawal status when available
    // (matched via referenceId), reversals are reversed.
    const linkedWithdrawal = entry.referenceId ? withdrawalById.get(String(entry.referenceId)) : undefined;
    // DEDUP: when a withdrawal RECORD exists for this ledger entry, the
    // first-class withdrawal row below already renders it (with the live
    // transfer status). Pushing the WITHDRAWAL_INITIATED ledger row as well
    // made every withdrawal appear TWICE in the history — skip it here.
    if (linkedWithdrawal && /WITHDRAWAL_INITIATED/.test(entryType)) return;
    const ledgerStatus = linkedWithdrawal
      ? txStatus(linkedWithdrawal.status) ?? (/WITHDRAWAL_INITIATED/.test(entryType) ? "PROCESSING" : "COMPLETED")
      : /WITHDRAWAL_INITIATED/.test(entryType)
        ? "PROCESSING"
        : /REVERSAL/.test(entryType)
          ? "REVERSED"
          : "COMPLETED";
    out.push({
      id: String(entry.id || `ledger-${entry.createdAt}-${entry.amountMinor}`),
      kind,
      direction,
      amountMinor: Number(entry.amountMinor ?? 0),
      label: String(entry.entryType || "Ledger entry").replace(/_/g, " "),
      narration: linkedWithdrawal && /WITHDRAWAL_INITIATED/.test(entryType)
        ? (String(linkedWithdrawal.error ?? "") || `Withdrawal to ${linkedWithdrawal.bankName ?? linkedWithdrawal.bankCode ?? "bank"} ••••${String(linkedWithdrawal.accountNumber ?? "").slice(-4)}`)
        : entry.description || entry.narration,
      referenceId: entry.referenceId,
      createdAt: entry.createdAt || new Date().toISOString(),
      balanceAfterMinor: entry.balanceAfterMinor != null ? Number(entry.balanceAfterMinor) : undefined,
      status: ledgerStatus,
      raw: entry,
    });
  });
  (data.walletTransactions || []).forEach((tx: any) => {
    const txType = String(tx.type || tx.direction || "").toUpperCase();
    // DEDUP (investment): the first-class investment row below already renders
    // this money. The old credit test even matched the "IN" substring of
    // INVESTMENT and rendered it as a phantom CREDIT — skip the row entirely.
    if (txType === "INVESTMENT") return;
    const isCredit = txType === "DEPOSIT";
    const amountMinor = tx.amountMinor != null ? Number(tx.amountMinor) : tx.amountNaira != null ? Number(tx.amountNaira) * 100 : 0;
    out.push({
      id: String(tx.id || `wallet-${tx.createdAt}-${tx.amountMinor}`),
      kind: isCredit ? "DEPOSIT" : "OTHER",
      direction: isCredit ? "CREDIT" : "DEBIT",
      amountMinor: Number.isFinite(amountMinor) ? amountMinor : 0,
      label: isCredit ? "Wallet funding" : tx.type ? String(tx.type).replace(/_/g, " ") : "Wallet transaction",
      narration: tx.description || tx.narration || (isCredit ? `Wallet funding via ${String(tx.provider ?? "payment gateway")}` : undefined),
      referenceId: tx.reference || tx.txRef || tx.transactionId,
      createdAt: tx.createdAt || new Date().toISOString(),
      balanceAfterMinor: tx.balanceAfterMinor != null ? Number(tx.balanceAfterMinor) : undefined,
      status: txStatus(tx.status),
      raw: tx,
    });
  });
  (data.investments || []).forEach((inv: any, i: number) => {
    const amountMinor = inv.amountMinor != null ? Number(inv.amountMinor) : inv.amountNaira != null ? Number(inv.amountNaira) * 100 : 0;
    out.push({
      id: String(inv.id || `inv-${i}`),
      kind: "INVESTMENT",
      direction: "DEBIT",
      amountMinor: Number.isFinite(amountMinor) ? amountMinor : 0,
      label: inv.planSnapshot?.name ? `Investment: ${inv.planSnapshot.name}` : "New investment",
      narration: `Investment created · Status: ${inv.status || "PENDING"}`,
      referenceId: inv.id,
      createdAt: inv.createdAt || new Date().toISOString(),
      status: txStatus(inv.status),
      raw: inv,
    });
  });
  (data.payouts || []).forEach((p: any, i: number) => {
    const amountMinor = p.amountMinor != null ? Number(p.amountMinor) : p.amountNaira != null ? Number(p.amountNaira) * 100 : 0;
    out.push({
      id: String(p.id || `payout-${i}`),
      kind: "PAYOUT",
      direction: "CREDIT",
      amountMinor: Number.isFinite(amountMinor) ? amountMinor : 0,
      label: "Investment payout",
      narration: `Payout status: ${p.status || "PENDING"}`,
      referenceId: p.referenceId || p.id,
      createdAt: p.createdAt || new Date().toISOString(),
      status: txStatus(p.status),
      raw: p,
    });
  });
  // First-class withdrawal rows: one per withdrawal attempt with its live
  // status — so SUCCESSFUL withdrawals finally render as successful in the
  // history (dedup: a row whose referenceId matches an already-added
  // withdrawal is skipped).
  const addedWithdrawalRefs = new Set<string>();
  (data.withdrawals || []).forEach((w: any, i: number) => {
    const amountMinor = w.amountMinor != null ? Number(w.amountMinor) : w.amountNaira != null ? Number(w.amountNaira) * 100 : 0;
    const refKey = String(w.id ?? `withdrawal-${i}`);
    if (addedWithdrawalRefs.has(refKey)) return;
    addedWithdrawalRefs.add(refKey);
    const bankLabel = w.bankName || w.bankCode || "bank";
    out.push({
      id: `withdrawal-${refKey}`,
      kind: "PAYOUT",
      direction: "DEBIT",
      amountMinor: Number.isFinite(amountMinor) ? amountMinor : 0,
      label: `Withdrawal · ${bankLabel}`,
      narration: `To ${bankLabel} ••••${String(w.accountNumber ?? "").slice(-4)}${w.accountName ? ` · ${w.accountName}` : ""}${w.error ? ` — ${w.error}` : ""}`,
      referenceId: w.id,
      createdAt: w.createdAt || new Date().toISOString(),
      status: txStatus(w.status) ?? "PROCESSING",
      raw: w,
    });
  });
  // React silently drops list rows whose keys collide — and collisions DO occur
  // when legacy rows lack an id and share the (createdAt, amount) fallback.
  // Guarantee unique ids so no transaction can ever silently vanish.
  const seenIds = new Set<string>();
  for (const row of out) {
    if (seenIds.has(row.id)) row.id = `${row.id}~${seenIds.size}`;
    seenIds.add(row.id);
  }
  return out.sort((a, b) => safeTxTime(b.createdAt) - safeTxTime(a.createdAt));
}
