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

const VELO_LOGO_URL = new URL("/velo-logo.png", import.meta.url).href;

function yyyyMMdd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function firstString(tx: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = tx[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function firstNumber(tx: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = tx[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function getTransactionLabel(tx: Record<string, unknown>): string {
  return firstString(tx, ["label", "title", "description"])
    ?? firstString(tx, ["kind", "entryType", "type"])?.replace(/_/g, " ")
    ?? "Transaction";
}

function getTransactionDirection(tx: Record<string, unknown>): "CREDIT" | "DEBIT" {
  const raw = firstString(tx, ["direction"]);
  if (raw === "CREDIT" || raw === "DEBIT") return raw;
  const amt = firstNumber(tx, ["amountMinor", "amountNaira", "amount"]) ?? 0;
  return amt >= 0 ? "CREDIT" : "DEBIT";
}

function getTransactionId(tx: Record<string, unknown>): string {
  return firstString(tx, ["id", "transactionId", "ledgerId", "payoutId", "investmentId"])
    ?? "TXN-" + Date.now().toString(36).toUpperCase();
}

function getTransactionDate(tx: Record<string, unknown>): string {
  return firstString(tx, ["createdAt", "date", "processedAt", "settledAt", "timestamp"])
    ?? new Date().toISOString();
}

function getAmountMinor(tx: Record<string, unknown>): number {
  const raw = firstNumber(tx, ["amountMinor"]);
  if (raw !== undefined) return raw;
  const naira = firstNumber(tx, ["amountNaira", "amount"]);
  if (naira !== undefined) return naira * 100;
  return 0;
}

function getReference(tx: Record<string, unknown>): string {
  return firstString(tx, ["referenceId", "reference", "txRef", "transactionRef", "providerReference", "flutterwaveRef"]) ?? "—";
}

function getNarration(tx: Record<string, unknown>): string {
  return firstString(tx, ["narration", "description", "note", "memo"]) ?? getTransactionLabel(tx);
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

async function loadLogoAsset(): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const [dataUrl, dims] = await Promise.all([
      fetch(VELO_LOGO_URL).then(async (r) => {
        if (!r.ok) return null;
        const blob = await r.blob();
        return await new Promise<string | null>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Invalid image"));
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }),
      new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve({ width: img.naturalWidth || 800, height: img.naturalHeight || 320 });
        img.onerror = () => reject(new Error("Logo load failed"));
        img.src = VELO_LOGO_URL;
      }),
    ]);
    return dataUrl && dims ? { dataUrl, width: dims.width, height: dims.height } : null;
  } catch (_e) {
    return null;
  }
}

async function buildPdf(
  tx: Record<string, unknown>,
  balanceBeforeMinor?: number,
  balanceAfterMinor?: number,
): Promise<jsPDF> {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 52;
  const contentWidth = pageWidth - margin * 2;
  const bottom = pageHeight - 66;
  const brand = "#0C4A6E";
  const accent = "#0EA5E9";
  const navy = "#0C2947";
  const slate = "#475569";
  const slateDark = "#1E293B";
  const green = "#059669";
  const red = "#B91C1C";
  const amber = "#B45309";
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

  function setText(size: number, bold = false, color: number | string = slate) {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    if (typeof color === "string") doc.setTextColor(color);
    else doc.setTextColor(slate);
  }

  const logo = await loadLogoAsset();

  function drawHeader() {
    y = 58;
    doc.setFillColor(brand);
    doc.rect(0, 0, pageWidth, 6, "F");
    doc.setFillColor("#F8FAFC");
    doc.roundedRect(margin, 24, contentWidth, 112, 10, 10, "F");
    doc.setDrawColor("#E2E8F0");
    doc.setLineWidth(0.6);
    doc.roundedRect(margin, 24, contentWidth, 112, 10, 10, "S");

    const logoMaxW = 152;
    const logoMaxH = 56;
    let logoW = 115;
    let logoH = 46;
    if (logo) {
      const ratio = Math.min(logoMaxW / logo.width, logoMaxH / logo.height);
      logoW = Math.floor(logo.width * ratio);
      logoH = Math.floor(logo.height * ratio);
    }
    const logoX = margin + 20;
    const logoY = 24 + Math.floor((112 - logoH) / 2);
    if (logo) {
      try {
        doc.addImage(logo.dataUrl, "PNG", logoX, logoY, logoW, logoH, undefined, "FAST");
      } catch (_e) {
        doc.setFillColor(brand);
        doc.roundedRect(logoX, logoY, logoW, logoH, 8, 8, "F");
        setText(18, true, "#FFFFFF");
        doc.text("VELO", logoX + logoW / 2, logoY + logoH / 2 + 6, { align: "center" });
      }
    } else {
      doc.setFillColor(brand);
      doc.roundedRect(logoX, logoY, logoW, logoH, 8, 8, "F");
      setText(18, true, "#FFFFFF");
      doc.text("VELO", logoX + logoW / 2, logoY + logoH / 2 + 6, { align: "center" });
    }

    const rightColX = pageWidth - margin - 20;
    setText(8, true, brand);
    doc.text("OFFICIAL TRANSACTION RECEIPT", rightColX, 44, { align: "right" });

    setText(10.5, true, slateDark);
    doc.text("Receipt Reference:", rightColX, 64, { align: "right" });
    setText(11.5, true, navy);
    doc.text(txId.slice(0, 12).toUpperCase(), rightColX, 79, { align: "right" });

    setText(10.5, true, slateDark);
    doc.text("Date Issued:", rightColX, 98, { align: "right" });
    setText(11, false, navy);
    doc.text(new Date(txDate).toLocaleString("en-NG"), rightColX, 113, { align: "right" });

    const companyBlockX = logoX + logoW + 20;
    setText(14, true, navy);
    doc.text(config.companyName, companyBlockX, 58);
    setText(9, false, slate);
    doc.text("Personal & Business Loans · CBN Regulated · NDIC Insured", companyBlockX, 75);
    setText(9, false, slate);
    doc.text(config.companyWebsite, companyBlockX, 90);
    setText(9, false, slate);
    doc.text(`Payment Reference: ${reference}`, companyBlockX, 105);
    setText(9, false, slate);
    doc.text(`Generated: ${new Date().toLocaleDateString("en-NG")}`, companyBlockX, 120);

    y = 160;
  }

  function drawFooter() {
    doc.setDrawColor("#CBD5E1");
    doc.setLineWidth(0.5);
    doc.line(margin, pageHeight - 48, pageWidth - margin, pageHeight - 48);
    setText(8.5, true, slateDark);
    doc.text(`${config.companyName} · Official Transaction Receipt · ${txId.slice(0, 8).toUpperCase()}`, margin, pageHeight - 32);
    setText(8.5, false, slate);
    doc.text(`${config.companyWebsite} · support@velocredit.ng`, margin, pageHeight - 18);
    setText(9, true, navy);
    doc.text(`Page 1 of 1`, pageWidth - margin, pageHeight - 32, { align: "right" });
    setText(8.5, false, slate);
    doc.text(`Reg. No. RCxxxxxxx`, pageWidth - margin, pageHeight - 18, { align: "right" });
  }

  drawHeader();

  requireSpace(44);
  setText(22, true, navy);
  doc.text("TRANSACTION RECEIPT", pageWidth / 2, y, { align: "center" });
  y += 16;
  setText(10, false, slate);
  doc.text(`Thank you for banking with ${config.companyName}. This is your official receipt.`, pageWidth / 2, y, { align: "center" });
  y += 10;
  setText(9, false, slate);
  doc.text("All amounts shown in Nigerian Naira (NGN). Generated electronically and valid without a signature.", pageWidth / 2, y, { align: "center" });
  y += 30;

  requireSpace(250);
  doc.setFillColor("#F8FAFC");
  doc.setDrawColor("#CBD5E1");
  doc.setLineWidth(0.6);
  doc.roundedRect(margin, y, contentWidth, 238, 12, 12, "F");
  doc.roundedRect(margin, y, contentWidth, 238, 12, 12, "S");
  doc.setFillColor(accent);
  doc.roundedRect(margin, y, contentWidth, 30, 12, 12, "F");
  y += 22;
  setText(10.5, true, "#FFFFFF");
  doc.text("   TRANSACTION DETAILS", margin + 6, y);
  y += 28;

  const rows: [string, string, "amount" | "direction" | "normal"][] = [
    ["Transaction ID", txId.slice(0, Math.min(18, txId.length)).toUpperCase(), "normal"],
    ["Date & Time", new Date(txDate).toLocaleString("en-NG"), "normal"],
    ["Transaction Type", txLabel, "normal"],
    ["Movement", direction === "CREDIT" ? "Credit · Money In" : "Debit · Money Out", "direction"],
    ["Payment Reference", reference, "normal"],
    ["Description / Narration", narration, "normal"],
  ];

  const labelColumnX = margin + 20;
  const valueColumnX = margin + contentWidth - 20;
  const labelWidth = 170;
  const valueWidth = contentWidth - 200;
  rows.forEach(([lbl, val, kind]) => {
    requireSpace(26);
    setText(9.5, true, slateDark);
    doc.text(lbl, labelColumnX, y + 4);

    if (kind === "direction") {
      setText(10, true, direction === "CREDIT" ? green : red);
    } else {
      setText(10, false, navy);
    }
    const valLines = doc.splitTextToSize(val, valueWidth) as string[];
    valLines.forEach((line, li) => {
      doc.text(line, valueColumnX, y + 4 + li * 13, { align: "right" });
    });
    y += 28;
  });

  y += 8;
  requireSpace(96);
  doc.setFillColor(direction === "CREDIT" ? "#ECFDF5" : "#FEF2F2");
  doc.setDrawColor(direction === "CREDIT" ? green : red);
  doc.setLineWidth(1);
  doc.roundedRect(margin, y, contentWidth, 88, 12, 12, "F");
  doc.roundedRect(margin, y, contentWidth, 88, 12, 12, "S");
  doc.setFillColor(direction === "CREDIT" ? green : red);
  doc.roundedRect(margin, y, 8, 88, 12, 12, "F");

  const amountBgX = margin + 20;
  setText(9, true, direction === "CREDIT" ? green : red);
  doc.text("TRANSACTION AMOUNT", amountBgX, y + 28);
  setText(10, false, slate);
  doc.text("Total movement on your wallet", amountBgX, y + 46);

  setText(11, true, slateDark);
  doc.text("Amount", pageWidth - margin - 20, y + 28, { align: "right" });
  setText(24, true, direction === "CREDIT" ? green : red);
  const amountStr = `${direction === "CREDIT" ? "+ " : "− "}${formatNaira(amountMinor)}`;
  doc.text(amountStr, pageWidth - margin - 20, y + 56, { align: "right" });
  y += 108;

  if (balanceBeforeMinor !== undefined || balanceAfterMinor !== undefined) {
    requireSpace(120);
    doc.setFillColor("#F8FAFC");
    doc.setDrawColor("#CBD5E1");
    doc.setLineWidth(0.6);
    doc.roundedRect(margin, y, contentWidth, 108, 12, 12, "F");
    doc.roundedRect(margin, y, contentWidth, 108, 12, 12, "S");
    doc.setFillColor(brand);
    doc.roundedRect(margin, y, contentWidth, 30, 12, 12, "F");
    y += 22;
    setText(10.5, true, "#FFFFFF");
    doc.text("   WALLET BALANCE", margin + 6, y);
    y += 26;

    const colMid = margin + contentWidth / 2;
    const innerPad = 22;

    setText(9.5, true, slate);
    doc.text("Balance Before", margin + innerPad, y);
    setText(15, true, slateDark);
    doc.text(
      balanceBeforeMinor !== undefined ? formatNaira(balanceBeforeMinor) : "—",
      margin + innerPad,
      y + 22,
    );

    doc.setDrawColor("#E2E8F0");
    doc.setLineWidth(0.6);
    doc.line(colMid, y - 10, colMid, y + 42);

    setText(9.5, true, slate);
    doc.text("Balance After", colMid + innerPad, y);
    setText(15, true, green);
    doc.text(
      balanceAfterMinor !== undefined ? formatNaira(balanceAfterMinor) : "—",
      colMid + innerPad,
      y + 22,
    );
    y += 68;
  }

  y += 14;
  requireSpace(128);
  doc.setFillColor("#FFFBEB");
  doc.setDrawColor("#F59E0B");
  doc.setLineWidth(0.6);
  doc.roundedRect(margin, y, contentWidth, 116, 12, 12, "F");
  doc.roundedRect(margin, y, contentWidth, 116, 12, 12, "S");
  doc.setFillColor(amber);
  doc.roundedRect(margin, y, 8, 116, 12, 12, "F");
  y += 20;
  setText(10.5, true, amber);
  doc.text("   IMPORTANT NOTICE", margin + 6, y);
  y += 20;
  setText(9.5, true, "#78350F");
  const noticeLines = [
    "1. This receipt serves as OFFICIAL confirmation of the transaction detailed above.",
    "2. Any discrepancy or dispute must be reported within 7 days of the transaction date.",
    `3. For enquiries, contact support via the ${config.companyName} dashboard or email support@velocredit.ng.`,
    "4. This receipt was generated electronically — it is legally valid without any handwritten signature or stamp.",
    "5. Transactions are processed in accordance with CBN regulations and NDIC insurance guidelines.",
  ];
  noticeLines.forEach((line) => {
    requireSpace(16);
    doc.text(doc.splitTextToSize(line, contentWidth - 40), margin + 20, y);
    y += 16;
  });

  y += 12;
  requireSpace(76);
  doc.setFillColor("#F0F9FF");
  doc.setDrawColor("#BAE6FD");
  doc.setLineWidth(0.6);
  doc.roundedRect(margin, y, contentWidth, 64, 12, 12, "F");
  doc.roundedRect(margin, y, contentWidth, 64, 12, 12, "S");
  setText(12, true, navy);
  doc.text(`Thank you for choosing ${config.companyName}.`, pageWidth / 2, y + 28, { align: "center" });
  setText(10, false, slate);
  doc.text(`${config.companyName} · ${config.companyWebsite} · Regulated by CBN · NDIC Insured`, pageWidth / 2, y + 48, { align: "center" });

  drawFooter();

  return doc;
}
