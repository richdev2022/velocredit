import { useState } from "react";
import jsPDF from "jspdf";
import { formatDateLabel, formatNaira } from "../utils/loanCalculator";
import { config } from "../utils/config";

interface ReceiptDownloadProps {
  transaction: Record<string, unknown>;
  balanceBeforeMinor?: number;
  balanceAfterMinor?: number;
  label?: string;
  disabled?: boolean;
}

function yyyyMMdd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function getTransactionLabel(tx: Record<string, unknown>): string {
  if (tx.label && typeof tx.label === "string") return tx.label;
  if (tx.kind && typeof tx.kind === "string") {
    return String(tx.kind).replace(/_/g, " ");
  }
  if (tx.entryType && typeof tx.entryType === "string") {
    return String(tx.entryType).replace(/_/g, " ");
  }
  return "Transaction";
}

function getTransactionDirection(tx: Record<string, unknown>): "CREDIT" | "DEBIT" {
  if (tx.direction === "CREDIT" || tx.direction === "DEBIT") return tx.direction;
  const amt = typeof tx.amountMinor === "number" ? tx.amountMinor : 0;
  return amt >= 0 ? "CREDIT" : "DEBIT";
}

function getTransactionId(tx: Record<string, unknown>): string {
  if (tx.id && typeof tx.id === "string") return tx.id;
  if (tx.transactionId && typeof tx.transactionId === "string") return tx.transactionId;
  return "TXN-" + Date.now().toString(36).toUpperCase();
}

function getTransactionDate(tx: Record<string, unknown>): string {
  if (tx.createdAt && typeof tx.createdAt === "string") return tx.createdAt;
  return new Date().toISOString();
}

function getAmountMinor(tx: Record<string, unknown>): number {
  if (typeof tx.amountMinor === "number") return tx.amountMinor;
  if (typeof tx.amount === "number") return tx.amount;
  return 0;
}

function getReference(tx: Record<string, unknown>): string {
  if (tx.referenceId && typeof tx.referenceId === "string") return tx.referenceId;
  if (tx.reference && typeof tx.reference === "string") return tx.reference;
  if (tx.txRef && typeof tx.txRef === "string") return tx.txRef;
  return "—";
}

function getNarration(tx: Record<string, unknown>): string {
  if (tx.narration && typeof tx.narration === "string") return tx.narration;
  if (tx.description && typeof tx.description === "string") return tx.description;
  if (tx.label && typeof tx.label === "string") return tx.label;
  return "—";
}

export default function ReceiptDownload({ transaction, balanceBeforeMinor, balanceAfterMinor, label, disabled }: ReceiptDownloadProps) {
  const [generating, setGenerating] = useState(false);

  async function handleDownload() {
    setGenerating(true);
    try {
      const document = await buildPdf(transaction, balanceBeforeMinor, balanceAfterMinor);
      const id = getTransactionId(transaction);
      const d = new Date(getTransactionDate(transaction));
      document.save(`Velo_Receipt_${id.slice(0, 8).toUpperCase()}_${yyyyMMdd(d)}.pdf`);
    } catch (_e) {
      console.error("[receipt] PDF generation failed", _e);
      alert("Could not generate the receipt. Please try again.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={disabled || generating}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:hover:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 text-[11px] font-bold transition disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <span>{generating ? "⏳" : "📄"}</span>
      <span>{generating ? "Generating…" : label || "Download Receipt"}</span>
    </button>
  );
}

async function buildPdf(
  tx: Record<string, unknown>,
  balanceBeforeMinor?: number,
  balanceAfterMinor?: number,
): Promise<jsPDF> {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 54;
  const contentWidth = pageWidth - margin * 2;
  const bottom = pageHeight - 66;
  const brand = "#0C4A6E";
  const accent = "#0EA5E9";
  const navy = "#0C2947";
  const slate = "#475569";
  const green = "#059669";
  const red = "#B91C1C";
  let y = 58;

  const txId = getTransactionId(tx);
  const txDate = getTransactionDate(tx);
  const txLabel = getTransactionLabel(tx);
  const direction = getTransactionDirection(tx);
  const amountMinor = Math.abs(getAmountMinor(tx));
  const reference = getReference(tx);
  const narration = getNarration(tx);

  function addPage() {
    doc.addPage();
    y = 58;
    drawHeader();
    drawFooter();
  }

  function requireSpace(height: number) {
    if (y + height > bottom) addPage();
  }

  function setText(size: number, bold = false, color = slate) {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(color);
  }

  function drawHeader() {
    y = 58;
    doc.setFillColor(accent);
    doc.rect(0, 0, pageWidth, 4, "F");
    doc.setFillColor("#EAF4FB");
    doc.roundedRect(margin, 25, contentWidth, 57, 8, 8, "F");
    setText(8.5, false, slate);
    doc.text("OFFICIAL TRANSACTION RECEIPT", pageWidth - margin - 12, 41, { align: "right" });
    setText(17, true, navy);
    doc.text(config.companyName, margin + 148, 48);
    setText(8.5, true, brand);
    doc.text("Personal & Business Loans | CBN Regulated | NDIC Insured", margin + 148, 62);
    setText(8.5, false, slate);
    doc.text(config.companyWebsite, margin + 148, 74);
    setText(8.5, false, slate);
    doc.text("Receipt Ref:", pageWidth - margin - 12, 57, { align: "right" });
    setText(10.5, true, navy);
    doc.text(txId.slice(0, 10).toUpperCase(), pageWidth - margin - 12, 70, { align: "right" });
    setText(8.5, false, slate);
    doc.text(`Date: ${formatDateLabel(txDate)}`, pageWidth - margin - 12, 83, { align: "right" });
    y = 108;
  }

  function drawFooter() {
    doc.setDrawColor("#CBD5E1");
    doc.setLineWidth(0.5);
    doc.line(margin, pageHeight - 45, pageWidth - margin, pageHeight - 45);
    setText(8.5, true, "#334155");
    doc.text(`${config.companyName} — Transaction Receipt ${txId.slice(0, 8).toUpperCase()}`, margin, pageHeight - 29);
    setText(9, true, navy);
    doc.text(`Page 1 of 1`, pageWidth - margin, pageHeight - 29, { align: "right" });
  }

  const logo = await loadLogoDataUrl("/velo-logo.png");
  if (logo) {
    try {
      doc.addImage(logo, "PNG", margin + 12, 34, 115, 46, undefined, "FAST");
    } catch (_e) {
      // ignore logo failure
    }
  }

  drawHeader();

  requireSpace(60);
  setText(20, true, navy);
  doc.text("TRANSACTION RECEIPT", pageWidth / 2, y, { align: "center" });
  y += 16;
  setText(9.5, false, slate);
  doc.text("This document is an official record of your transaction with Velo Finance.", pageWidth / 2, y, { align: "center" });
  y += 22;

  requireSpace(230);
  doc.setDrawColor(accent);
  doc.setLineWidth(0.8);
  doc.roundedRect(margin, y, contentWidth, 215, 10, 10, "S");
  doc.setFillColor("#EAF4FB");
  doc.roundedRect(margin, y, contentWidth, 34, 10, 10, "F");
  y += 24;
  setText(10, true, brand);
  doc.text("   TRANSACTION DETAILS", margin + 8, y);
  y += 16;

  const rows: [string, string][] = [
    ["Transaction ID:", txId],
    ["Date & Time:", new Date(txDate).toLocaleString("en-NG")],
    ["Transaction Type:", txLabel],
    ["Direction:", direction === "CREDIT" ? "Credit (Money In)" : "Debit (Money Out)"],
    ["Reference:", reference],
    ["Narration:", narration],
  ];

  rows.forEach(([lbl, val], i) => {
    requireSpace(22);
    setText(9, true, "#334155");
    doc.text(lbl, margin + 16, y + 4);
    setText(9, i === 3 ? (direction === "CREDIT" ? true : true) : false, i === 3 ? (direction === "CREDIT" ? green : red) : navy);
    const valLines = doc.splitTextToSize(val, contentWidth * 0.52) as string[];
    valLines.forEach((l, li) => doc.text(l, pageWidth - margin - 16, y + 4 + li * 14, { align: "right" }));
    y += 22;
  });

  y += 6;
  requireSpace(80);
  doc.setFillColor(direction === "CREDIT" ? "#ECFDF5" : "#FEF2F2");
  doc.setDrawColor(direction === "CREDIT" ? green : red);
  doc.setLineWidth(0.8);
  doc.roundedRect(margin, y, contentWidth, 72, 10, 10, "F");
  doc.roundedRect(margin, y, contentWidth, 72, 10, 10, "S");
  y += 22;
  setText(9, true, direction === "CREDIT" ? green : red);
  doc.text("   AMOUNT", margin + 8, y);
  setText(10, true, slate);
  doc.text("Transaction Amount", margin + 16, y + 28);
  setText(22, true, direction === "CREDIT" ? green : red);
  doc.text(
    `${direction === "CREDIT" ? "+" : "-"}${formatNaira(amountMinor)}`,
    pageWidth - margin - 16,
    y + 32,
    { align: "right" },
  );
  y += 80;

  if (balanceBeforeMinor !== undefined || balanceAfterMinor !== undefined) {
    requireSpace(110);
    doc.setFillColor("#F8FAFC");
    doc.setDrawColor("#CBD5E1");
    doc.setLineWidth(0.5);
    doc.roundedRect(margin, y, contentWidth, 98, 10, 10, "F");
    doc.roundedRect(margin, y, contentWidth, 98, 10, 10, "S");
    doc.setFillColor("#F1F5F9");
    doc.roundedRect(margin, y, contentWidth, 30, 10, 10, "F");
    y += 22;
    setText(10, true, brand);
    doc.text("   WALLET BALANCE", margin + 8, y);
    y += 20;

    const colMid = margin + contentWidth / 2;
    setText(9, true, slate);
    doc.text("Balance Before", margin + 16, y);
    setText(13, true, navy);
    doc.text(
      balanceBeforeMinor !== undefined ? formatNaira(balanceBeforeMinor) : "—",
      margin + 16,
      y + 22,
    );

    doc.setDrawColor("#E2E8F0");
    doc.line(colMid, y - 8, colMid, y + 34);

    setText(9, true, slate);
    doc.text("Balance After", colMid + 16, y);
    setText(13, true, green);
    doc.text(
      balanceAfterMinor !== undefined ? formatNaira(balanceAfterMinor) : "—",
      colMid + 16,
      y + 22,
    );
    y += 58;
  }

  y += 10;
  requireSpace(120);
  doc.setFillColor("#FFFBEB");
  doc.setDrawColor("#F59E0B");
  doc.setLineWidth(0.5);
  doc.roundedRect(margin, y, contentWidth, 105, 10, 10, "F");
  doc.roundedRect(margin, y, contentWidth, 105, 10, 10, "S");
  y += 20;
  setText(10, true, "#B45309");
  doc.text("   IMPORTANT NOTICE", margin + 8, y);
  y += 18;
  setText(9, false, "#78350F");
  const noticeLines = [
    "1. This receipt serves as official confirmation of the above transaction.",
    "2. All disputes must be raised within 7 days of the transaction date.",
    "3. For enquiries, contact our support team via the Velo Finance dashboard or email support@velocredit.ng",
    "4. This document was generated electronically and is valid without a signature.",
  ];
  noticeLines.forEach((line) => {
    requireSpace(16);
    doc.text(doc.splitTextToSize(line, contentWidth - 32), margin + 16, y);
    y += 16;
  });

  y += 14;
  requireSpace(60);
  doc.setFillColor("#EAF4FB");
  doc.roundedRect(margin, y, contentWidth, 48, 8, 8, "F");
  setText(11, true, navy);
  doc.text(`Thank you for choosing ${config.companyName}.`, pageWidth / 2, y + 22, { align: "center" });
  y += 28;
  setText(9, false, slate);
  doc.text(`${config.companyName} | ${config.companyWebsite} | Regulated by CBN | NDIC Insured`, pageWidth / 2, y + 10, { align: "center" });

  drawFooter();

  return doc;
}

async function loadLogoDataUrl(src: string): Promise<string | null> {
  try {
    const response = await fetch(src);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Invalid image"));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (_e) {
    return null;
  }
}
