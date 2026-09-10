const fs = require('fs');
let content = fs.readFileSync('backend/server/routes.ts', 'utf8');

// 1. Update store imports
// Find current store import line(s)
const storeImportPattern = /from "\.\/store\.js";?/g;
const matches = [...content.matchAll(storeImportPattern)];
console.log("Store import matches:", matches.length);
if (matches.length > 0) {
  const lastMatch = matches[matches.length - 1];
  console.log("Last store import at index:", lastMatch.index);
  const startOfImport = content.lastIndexOf("import ", lastMatch.index);
  console.log("Import starts at:", startOfImport);
  
  const importEndIdx = lastMatch.index + lastMatch[0].length;
  const storeImportBlock = content.slice(startOfImport, importEndIdx);
  console.log("\nCurrent store import (first 400 chars):");
  console.log(storeImportBlock.slice(0, 400));
  
  // Insert new imports after the existing last import in this block
  const importsToAdd = [
    "getAdminLedgerBalanceMinor",
    "adminLedger",
    "getPlatformSettings",
    "updatePlatformSettings",
    "setInvestorEarningRateOverride",
    "getEffectiveInvestorRate",
    "investorWithdrawals",
    "appendAdminLedger",
    "notifications",
  ];
  
  // Strategy: find the last } before "from" and add items
  const closeBraceIdx = storeImportBlock.lastIndexOf("}");
  const beforeBrace = storeImportBlock.slice(0, closeBraceIdx);
  const afterBrace = storeImportBlock.slice(closeBraceIdx);
  
  // Check what's currently imported
  const additions = importsToAdd.filter(i => !storeImportBlock.includes(i));
  console.log("\nImports to add:", additions);
  
  if (additions.length > 0) {
    const addStr = ",\n  " + additions.join(",\n  ");
    const newStoreImport = beforeBrace.trimEnd() + addStr + "\n" + afterBrace;
    content = content.slice(0, startOfImport) + newStoreImport + content.slice(importEndIdx);
    console.log("✅ Updated store imports");
  } else {
    console.log("All imports already present");
  }
}

// 2. Check for investorWithdrawalEmail import
if (!content.includes("investorWithdrawalEmail")) {
  console.log("\ninvestorWithdrawalEmail not imported - checking email import...");
  const emailImportIdx = content.indexOf('from "./email.js"');
  if (emailImportIdx > 0) {
    const startEmailImport = content.lastIndexOf("import ", emailImportIdx);
    const endEmailImport = emailImportIdx + 'from "./email.js"'.length;
    let emailImport = content.slice(startEmailImport, endEmailImport);
    console.log("Current email import:", emailImport);
    
    if (!emailImport.includes("investorWithdrawalEmail")) {
      const closeBraceEmail = emailImport.lastIndexOf("}");
      const beforeEmail = emailImport.slice(0, closeBraceEmail).trimEnd();
      const afterEmail = emailImport.slice(closeBraceEmail);
      const newEmailImport = beforeEmail + ",\n  investorWithdrawalEmail\n" + afterEmail;
      content = content.slice(0, startEmailImport) + newEmailImport + content.slice(endEmailImport);
      console.log("✅ Added investorWithdrawalEmail to imports");
    }
  }
}

// 3. Now append all admin routes + investor withdrawal endpoint before export default router
const exportIdx = content.lastIndexOf("export default router;");

const adminAndWithdrawalRoutes = `
// ===============================
// Investor withdrawal endpoint
// ===============================
router.post("/investor/wallet/withdraw", requireAuth, requireRole(["INVESTOR"]), async (req: AuthRequest, res) => {
  const schema = z.object({
    amountNaira: z.number().positive().max(50_000_000),
    bankCode: z.string().min(2).max(10),
    accountNumber: z.string().regex(/^\\d{10}$/),
    narration: z.string().max(100).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const userId = req.user!.id;
  const wallet = findWallet(userId);
  const investor = users.find((u) => u.id === userId);
  if (!wallet || !investor) {
    res.status(404).json({ ok: false, error: "Wallet not found" });
    return;
  }
  const settings = getPlatformSettings();
  const feePercent = settings.investorWithdrawalFeePercent ?? 0;
  const flatMinor = settings.investorWithdrawalFeeFlatMinor ?? 0;
  const amountMinor = Math.round(parsed.data.amountNaira * 100);
  const feePercentMinor = Math.round(amountMinor * (feePercent / 100));
  const totalFeeMinor = feePercentMinor + flatMinor;
  const netMinor = amountMinor - totalFeeMinor;
  if (netMinor < 0 || wallet.availableMinor < amountMinor) {
    res.status(400).json({ ok: false, error: "Insufficient wallet balance" });
    return;
  }
  const bank = await resolveBankAccount(parsed.data.bankCode, parsed.data.accountNumber);
  if (!bank.ok) {
    res.status(400).json({ ok: false, error: bank.error ?? "Could not verify bank account" });
    return;
  }
  appendLedger(wallet, {
    entryType: "WITHDRAWAL_INITIATED",
    referenceId: "pending",
    amountMinor,
    direction: "DEBIT",
    description: \`Withdrawal to \${bank.bankName} *\${parsed.data.accountNumber.slice(-4)}\`,
    metadata: {
      bankCode: parsed.data.bankCode,
      accountNumber: parsed.data.accountNumber,
      beneficiaryName: bank.accountName,
      feeMinor: totalFeeMinor,
      netMinor,
    },
  });
  if (flatMinor > 0) {
    appendAdminLedger({
      entryType: "WITHDRAWAL_FEE",
      investorId: userId,
      amountMinor: flatMinor,
      direction: "CREDIT",
      description: "Flat withdrawal fee collected",
      metadata: { feeType: "FLAT", amountMinor: flatMinor },
    });
  }
  if (feePercentMinor > 0) {
    appendAdminLedger({
      entryType: "WITHDRAWAL_FEE",
      investorId: userId,
      amountMinor: feePercentMinor,
      direction: "CREDIT",
      description: \`Percentage withdrawal fee (\${feePercent}%)\`,
      metadata: { feeType: "PERCENT", percent: feePercent, amountMinor: feePercentMinor },
    });
  }
  const withdrawalId = randomUUID();
  const withdrawalEntry = {
    id: withdrawalId,
    investorId: userId,
    amountNaira: parsed.data.amountNaira,
    feeNaira: Math.round(totalFeeMinor) / 100,
    netNaira: Math.round(netMinor) / 100,
    currency: "NGN" as const,
    bankCode: parsed.data.bankCode,
    bankName: bank.bankName,
    accountNumber: parsed.data.accountNumber,
    accountName: bank.accountName,
    status: "PENDING_APPROVAL" as const,
    narration: parsed.data.narration,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  investorWithdrawals.push(withdrawalEntry);
  if (wallet.ledger && wallet.ledger.length > 0) {
    const lastEntry = wallet.ledger[wallet.ledger.length - 1];
    if (lastEntry && lastEntry.referenceId === "pending") {
      lastEntry.referenceId = withdrawalId;
    }
  }
  const emailTpl = investorWithdrawalEmail({
    investorName: investor.fullName,
    withdrawalId,
    amountNaira: parsed.data.amountNaira,
    feeNaira: Math.round(totalFeeMinor) / 100,
    netNaira: Math.round(netMinor) / 100,
    balanceNaira: Math.round(wallet.availableMinor) / 100,
    bankName: bank.bankName,
    accountNumber: parsed.data.accountNumber,
  });
  void sendEmail({
    to: investor.email,
    name: investor.fullName,
    subject: emailTpl.subject,
    html: emailTpl.html,
  }).then((emailRes) => {
    notifications.push({
      id: randomUUID(),
      userId: investor.id,
      channel: "EMAIL" as const,
      kind: "WITHDRAWAL_REQUEST" as const,
      subject: emailTpl.subject,
      recipientMasked: investor.email.replace(/^(.{3})[^@]*@(.*)$/, "$1***@$2"),
      status: emailRes.sent ? "SENT" : "NOT_CONFIGURED",
      providerMessageId: emailRes.providerReference,
      retryCount: 0,
      relatedEntityType: "WITHDRAWAL",
      relatedEntityId: withdrawalId,
      createdAt: new Date().toISOString(),
      sentAt: emailRes.sent ? new Date().toISOString() : undefined,
    });
  }).catch(() => undefined);
  res.json({
    ok: true,
    withdrawal: withdrawalEntry,
    feeBreakdown: {
      flatNaira: Math.round(flatMinor) / 100,
      percentNaira: Math.round(feePercentMinor) / 100,
      totalNaira: Math.round(totalFeeMinor) / 100,
      netNaira: Math.round(netMinor) / 100,
    },
  });
});

// ===============================
// Admin platform settings routes
// ===============================
router.get("/admin/settings/platform", requireAuth, requireRole(["ADMIN"]), async (_req, res) => {
  const settings = getPlatformSettings();
  const balanceMinor = getAdminLedgerBalanceMinor();
  res.json({
    ok: true,
    settings,
    adminLedgerBalanceMinor: balanceMinor,
    adminLedgerBalanceNaira: Math.round(balanceMinor) / 100,
  });
});

router.put("/admin/settings/platform", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  const schema = z.object({
    investorWithdrawalFeePercent: z.number().min(0).max(100).optional(),
    investorWithdrawalFeeFlatMinor: z.number().int().min(0).optional(),
    investorWithdrawalFeeFlatNaira: z.number().min(0).optional(),
    defaultInvestmentAnnualRatePercent: z.number().min(0).max(100).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const updates: Record<string, number> = {};
  if (parsed.data.investorWithdrawalFeePercent !== undefined) {
    updates.investorWithdrawalFeePercent = parsed.data.investorWithdrawalFeePercent;
  }
  if (parsed.data.investorWithdrawalFeeFlatMinor !== undefined) {
    updates.investorWithdrawalFeeFlatMinor = parsed.data.investorWithdrawalFeeFlatMinor;
  } else if (parsed.data.investorWithdrawalFeeFlatNaira !== undefined) {
    updates.investorWithdrawalFeeFlatMinor = Math.round(parsed.data.investorWithdrawalFeeFlatNaira * 100);
  }
  if (parsed.data.defaultInvestmentAnnualRatePercent !== undefined) {
    updates.defaultInvestmentAnnualRatePercent = parsed.data.defaultInvestmentAnnualRatePercent;
  }
  const updated = updatePlatformSettings(updates);
  res.json({ ok: true, settings: updated });
});

router.put("/admin/investors/:investorId/earning-rate", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  const schema = z.object({
    annualRatePercent: z.number().min(0).max(100),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const { investorId } = req.params;
  const investor = users.find((u) => u.id === investorId && u.role === "INVESTOR");
  if (!investor) {
    res.status(404).json({ ok: false, error: "Investor not found" });
    return;
  }
  const settings = setInvestorEarningRateOverride(investorId, parsed.data.annualRatePercent);
  res.json({
    ok: true,
    investor: {
      id: investorId,
      fullName: investor.fullName,
      email: investor.email,
      earningRatePercent: parsed.data.annualRatePercent,
    },
    settings,
  });
});

router.post("/admin/investors/:investorId/credit-wallet", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  const schema = z.object({
    amountNaira: z.number().positive().max(500_000_000),
    description: z.string().max(200).optional(),
    reason: z.enum(["MANUAL_CREDIT", "INVESTMENT_RETURN", "BONUS", "CORRECTION"]).default("MANUAL_CREDIT"),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const { investorId } = req.params;
  const investor = users.find((u) => u.id === investorId && u.role === "INVESTOR");
  const wallet = findWallet(investorId);
  if (!investor || !wallet) {
    res.status(404).json({ ok: false, error: "Investor or wallet not found" });
    return;
  }
  const amountMinor = Math.round(parsed.data.amountNaira * 100);
  const refId = randomUUID();
  appendAdminLedger({
    entryType: "INVESTMENT_RETURN_CREDIT",
    referenceId: refId,
    investorId,
    amountMinor,
    direction: "DEBIT",
    description: parsed.data.description ?? \`Admin manual credit - \${parsed.data.reason}\`,
    metadata: { reason: parsed.data.reason, creditedBy: req.user?.id },
  });
  appendLedger(wallet, {
    entryType: "INVESTMENT_RETURN",
    referenceId: refId,
    amountMinor,
    direction: "CREDIT",
    description: parsed.data.description ?? \`Admin credit: \${parsed.data.reason}\`,
    metadata: { reason: parsed.data.reason, creditedBy: req.user?.id },
  });
  const balanceNaira = Math.round(wallet.availableMinor) / 100;
  const emailTpl = investorWalletFundedEmail({
    investorName: investor.fullName,
    amountNaira: parsed.data.amountNaira,
    balanceNaira,
    reference: refId,
  });
  void sendEmail({
    to: investor.email,
    name: investor.fullName,
    subject: emailTpl.subject,
    html: emailTpl.html,
  }).then((emailRes) => {
    notifications.push({
      id: randomUUID(),
      userId: investorId,
      channel: "EMAIL" as const,
      kind: "WALLET_FUNDED" as const,
      subject: emailTpl.subject,
      recipientMasked: investor.email.replace(/^(.{3})[^@]*@(.*)$/, "$1***@$2"),
      status: emailRes.sent ? "SENT" : "NOT_CONFIGURED",
      providerMessageId: emailRes.providerReference,
      retryCount: 0,
      relatedEntityType: "WALLET_TRANSACTION",
      relatedEntityId: refId,
      createdAt: new Date().toISOString(),
      sentAt: emailRes.sent ? new Date().toISOString() : undefined,
    });
  }).catch(() => undefined);
  res.json({
    ok: true,
    walletBalanceMinor: wallet.availableMinor,
    walletBalanceNaira: Math.round(wallet.availableMinor) / 100,
    transactionId: refId,
  });
});

router.get("/admin/ledger", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 100)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const entryType = req.query.entryType ? String(req.query.entryType) : undefined;
  const filtered = entryType
    ? adminLedger.filter((e) => e.entryType === entryType)
    : adminLedger;
  const sorted = filtered.slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const page = sorted.slice(offset, offset + limit);
  const balanceMinor = getAdminLedgerBalanceMinor();
  res.json({
    ok: true,
    balanceMinor,
    balanceNaira: Math.round(balanceMinor) / 100,
    totalEntries: sorted.length,
    entries: page,
    limit,
    offset,
  });
});

router.get("/admin/investors/:investorId/withdrawals", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  const { investorId } = req.params;
  const statusFilter = req.query.status ? String(req.query.status) : undefined;
  let items = investorWithdrawals.filter((w) => w.investorId === investorId);
  if (statusFilter) items = items.filter((w) => w.status === statusFilter);
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ ok: true, withdrawals: items });
});

router.get("/admin/withdrawals", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  const statusFilter = req.query.status ? String(req.query.status) : undefined;
  let items = [...investorWithdrawals];
  if (statusFilter) items = items.filter((w) => w.status === statusFilter);
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 100)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  res.json({ ok: true, total: items.length, withdrawals: items.slice(offset, offset + limit) });
});

router.put("/admin/withdrawals/:withdrawalId/approve", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  const { withdrawalId } = req.params;
  const w = investorWithdrawals.find((x) => x.id === withdrawalId);
  if (!w) {
    res.status(404).json({ ok: false, error: "Withdrawal not found" });
    return;
  }
  if (w.status !== "PENDING_APPROVAL") {
    res.status(400).json({ ok: false, error: \`Withdrawal already \${w.status}\` });
    return;
  }
  try {
    const netMinor = Math.round(Number(w.netNaira) * 100);
    const transfer = await createInvestmentPayout({
      userId: w.investorId,
      amountMinor: netMinor,
      bankCode: w.bankCode,
      accountNumber: w.accountNumber,
      accountName: w.accountName,
      reference: \`WITHDRAWAL-\${w.id.slice(0, 8)}\`,
    });
    w.status = "PROCESSING";
    w.providerTransfer = transfer as any;
    w.updatedAt = new Date().toISOString();
    res.json({ ok: true, withdrawal: w, providerResponse: transfer });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

router.put("/admin/withdrawals/:withdrawalId/reject", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
  const schema = z.object({ reason: z.string().max(200).optional() });
  const parsed = schema.safeParse(req.body);
  const { withdrawalId } = req.params;
  const w = investorWithdrawals.find((x) => x.id === withdrawalId);
  if (!w) {
    res.status(404).json({ ok: false, error: "Withdrawal not found" });
    return;
  }
  if (w.status === "SUCCESSFUL") {
    res.status(400).json({ ok: false, error: "Cannot reject already completed withdrawal" });
    return;
  }
  const wallet = findWallet(w.investorId);
  const amountMinor = Math.round(Number(w.amountNaira) * 100);
  if (wallet) {
    appendLedger(wallet, {
      entryType: "WITHDRAWAL_REVERSAL",
      referenceId: w.id,
      amountMinor,
      direction: "CREDIT",
      description: \`Withdrawal reversal - \${parsed.data?.reason ?? "Rejected by admin"}\`,
    });
  }
  const feeMinor = Math.round(Number(w.feeNaira) * 100);
  if (feeMinor > 0) {
    appendAdminLedger({
      entryType: "REVERSAL",
      referenceId: w.id,
      investorId: w.investorId,
      amountMinor: feeMinor,
      direction: "DEBIT",
      description: "Reverse withdrawal fee due to rejection",
    });
  }
  w.status = "REJECTED";
  w.updatedAt = new Date().toISOString();
  res.json({ ok: true, withdrawal: w });
});

`;

content = content.slice(0, exportIdx) + adminAndWithdrawalRoutes + content.slice(exportIdx);

// 4. Add investorWalletFundedEmail import since admin credit-wallet uses it
if (!content.includes("investorWalletFundedEmail")) {
  const emailImportIdx = content.indexOf('from "./email.js"');
  if (emailImportIdx > 0) {
    const startEmailImport = content.lastIndexOf("import ", emailImportIdx);
    const endEmailImport = emailImportIdx + 'from "./email.js"'.length;
    let emailImport = content.slice(startEmailImport, endEmailImport);
    const closeBraceEmail = emailImport.lastIndexOf("}");
    const beforeEmail = emailImport.slice(0, closeBraceEmail).trimEnd();
    const afterEmail = emailImport.slice(closeBraceEmail);
    const newEmailImport = beforeEmail + ",\n  investorWalletFundedEmail\n" + afterEmail;
    content = content.slice(0, startEmailImport) + newEmailImport + content.slice(endEmailImport);
    console.log("✅ Added investorWalletFundedEmail to imports");
  }
}

// 5. Add resolveBankAccount and createInvestmentPayout imports if not already in routes
for (const fnName of ["resolveBankAccount", "createInvestmentPayout"]) {
  if (!content.includes(`"${fnName}"`) && !content.includes(`, ${fnName},`)) {
    const providerImportIdx = content.indexOf('from "./providers.js"');
    if (providerImportIdx > 0) {
      const startImport = content.lastIndexOf("import ", providerImportIdx);
      const endImport = providerImportIdx + 'from "./providers.js"'.length;
      let providerImport = content.slice(startImport, endImport);
      const closeBrace = providerImport.lastIndexOf("}");
      const before = providerImport.slice(0, closeBrace).trimEnd();
      const after = providerImport.slice(closeBrace);
      const newImport = before + ",\n  " + fnName + "\n" + after;
      content = content.slice(0, startImport) + newImport + content.slice(endImport);
      console.log("✅ Added " + fnName + " to providers imports");
    }
  }
}

// 6. Finally: apply earning rate override to investment creation endpoint
console.log("\nLooking for investment creation endpoint...");
const investStart = content.indexOf('router.post("/investments"');
if (investStart > 0) {
  // Find the section that computes expectedEarnings and use getEffectiveInvestorRate
  const nextRouteAfter = content.indexOf('router.get("/investments"', investStart);
  const investSection = content.slice(investStart, nextRouteAfter);
  console.log("Investment section found, length:", investSection.length);
  
  // Find plan.annualRatePercent and apply getEffectiveInvestorRate
  if (investSection.includes("annualRatePercent") && !investSection.includes("getEffectiveInvestorRate")) {
    // Try to find a common pattern - plan selection and rate application
    const ratePattern = /(plan\s*\?\s*plan\.annualRatePercent\s*:\s*)(\d+\.?\d*)/;
    const rateMatch = investSection.match(ratePattern);
    if (rateMatch) {
      console.log("Found rate pattern, applying fix...");
      const oldRate = rateMatch[0];
      const newRate = `getEffectiveInvestorRate(req.user!.id, plan ? plan.annualRatePercent : undefined)`;
      const oldChunkStart = investSection.indexOf(oldRate);
      const oldChunkEnd = oldChunkStart + oldRate.length;
      
      const newSection = investSection.slice(0, oldChunkStart) + newRate + investSection.slice(oldChunkEnd);
      content = content.slice(0, investStart) + newSection + content.slice(nextRouteAfter);
      console.log("✅ Applied getEffectiveInvestorRate to investment creation");
    } else {
      // Look for expectedEarnings calculation pattern as alternate
      const earningsIdx = investSection.indexOf("expectedEarningsMinor");
      if (earningsIdx > 0) {
        console.log("Found expectedEarningsMinor at:", earningsIdx);
        console.log("Context:", investSection.slice(earningsIdx - 150, earningsIdx + 100));
      }
    }
  } else if (investSection.includes("getEffectiveInvestorRate")) {
    console.log("Investment section already uses getEffectiveInvestorRate");
  }
}

fs.writeFileSync('backend/server/routes.ts', content);
console.log("\n✅ routes.ts patched successfully with admin routes & withdrawals");
