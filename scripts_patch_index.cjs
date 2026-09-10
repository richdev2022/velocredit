const fs = require('fs');
let content = fs.readFileSync('backend/server/index.ts', 'utf8');

const searchReturn = 'entryType: "INVESTMENT_RETURN"';
const idxReturn = content.indexOf(searchReturn);
console.log("INVESTMENT_RETURN index:", idxReturn);

if (idxReturn > 0) {
  const chunkStart = content.lastIndexOf('appendLedger(wallet, {', idxReturn);
  console.log("chunkStart:", chunkStart);
  
  // Find the matching end - look for closing of this block followed by subsequent blocks
  let braceCount = 0;
  let i = chunkStart;
  let blockEnd = -1;
  while (i < content.length) {
    if (content[i] === '{') braceCount++;
    if (content[i] === '}') {
      braceCount--;
      if (braceCount === 0 && i > chunkStart) {
        blockEnd = i + 1;
        break;
      }
    }
    i++;
  }
  console.log("blockEnd for appendLedger:", blockEnd);
  
  if (chunkStart > 0 && blockEnd > 0) {
    const before = content.slice(0, chunkStart);
    const after = content.slice(blockEnd);
    
    const replacement = `appendAdminLedger({
                  entryType: "INVESTMENT_PAYOUT",
                  referenceId: payout.id,
                  investorId: payout.userId,
                  amountMinor,
                  direction: "DEBIT",
                  description: \`Admin ledger debit for investment payout - \${payout.payoutType}\`,
                  metadata: {
                    provider: "flutterwave",
                    providerReference: payout.providerReference,
                    payoutType: payout.payoutType,
                    investmentId: investment.id,
                  },
                });
                appendLedger(wallet, {
                  entryType: "INVESTMENT_RETURN",
                  referenceId: investment.id,
                  amountMinor,
                  direction: "CREDIT",
                  description: \`Investment payout \${payout.id}\`,
                  metadata: {
                    provider: "flutterwave",
                    providerReference: payout.providerReference,
                    payoutType: payout.payoutType,
                  },
                });
                const investorUser = users.find((u) => u.id === payout.userId);
                if (investorUser) {
                  const principalVal = Number(payout.principalNaira ?? investment.amountNaira ?? 0);
                  const earningsVal = Number(payout.earningsNaira ?? investment.expectedEarningsNaira ?? 0);
                  const totalVal = Number(payout.amountNaira ?? 0);
                  const balanceNairaVal = Math.round(wallet.availableMinor) / 100;
                  const emailTpl = investorEarningsCreditedEmail({
                    investorName: investorUser.fullName,
                    investmentId: investment.id,
                    principalNaira: principalVal,
                    earningsNaira: earningsVal,
                    totalNaira: totalVal,
                    balanceNaira: balanceNairaVal,
                  });
                  void sendEmail({
                    to: investorUser.email,
                    name: investorUser.fullName,
                    subject: emailTpl.subject,
                    html: emailTpl.html,
                  }).then((emailRes) => {
                    notifications.push({
                      id: randomUUID(),
                      userId: investorUser.id,
                      channel: "EMAIL",
                      kind: "INVESTMENT_PAYOUT",
                      subject: emailTpl.subject,
                      recipientMasked: investorUser.email.replace(/^(.{3})[^@]*@(.*)$/, "$1***@$2"),
                      status: emailRes.sent ? "SENT" : "NOT_CONFIGURED",
                      providerMessageId: emailRes.providerReference,
                      retryCount: 0,
                      relatedEntityType: "PAYOUT",
                      relatedEntityId: payout.id,
                      createdAt: new Date().toISOString(),
                      sentAt: emailRes.sent ? new Date().toISOString() : undefined,
                    });
                  }).catch(() => undefined);
                }`;
    
    content = before + replacement + after;
    console.log("SUCCESS: Investment payout block updated");
  }
}

fs.writeFileSync('backend/server/index.ts', content);
console.log("File saved successfully");
