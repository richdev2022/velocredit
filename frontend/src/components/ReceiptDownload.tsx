import { useState } from "react";
import jsPDF from "jspdf";
import { formatNaira } from "../utils/loanCalculator";
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
  return (
    firstString(tx, ["label", "title", "description"])
    ?? firstString(tx, ["kind", "entryType", "type"])?.replace(/_/g, " ")
    ?? "Transaction"
  ).toUpperCase();
}

function getTransactionDirection(tx: Record<string, unknown>): "CREDIT" | "DEBIT" {
  const raw = firstString(tx, ["direction"]);
  if (raw === "CREDIT" || raw === "DEBIT") return raw;
  const amt = firstNumber(tx, ["amountMinor", "amountNaira", "amount"]) ?? 0;
  return amt >= 0 ? "CREDIT" : "DEBIT";
}

function getTransactionId(tx: Record<string, unknown>): string {
  return (
    firstString(tx, ["id", "transactionId", "ledgerId", "payoutId", "investmentId"])
    ?? "TXN-" + Date.now().toString(36).toUpperCase()
  ).toUpperCase();
}

function getTransactionDate(tx: Record<string, unknown>): string {
  return (
    firstString(tx, ["createdAt", "date", "processedAt", "settledAt", "timestamp"])
    ?? new Date().toISOString()
  );
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
      document.save(`Velo_Receipt_${id.slice(0, 8)}_${yyyyMMdd(d)}.pdf`);
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
          reader.onloadend = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Invalid image")));
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

function roundedRect(doc: jsPDF, x: number, y: number, w: number, h: number, r: number) {
  doc.roundedRect(x, y, w, h, r, r, "F");
}

async function buildPdf(
  tx: Record<string, unknown>,
  balanceBeforeMinor?: number,
  balanceAfterMinor?: number,
): Promise<jsPDF> {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 48;
  const contentWidth = pageWidth - margin * 2;

  const navy = "#0F172A";
  const slate = "#64748B";
  const cardBg = "#F8FAFC";
  const cardBorder = "#E2E8F0";
  const summaryBg = "#ECFDF5";
  const emerald = "#059669";
  const red = "#B91C1C";
  const emeraldStrong = "#047857";
  const heroBg = "#F0FDF4";
  const heroBorder = "#BBF7D0";
  const heroRedBg = "#FEF2F2";
  const heroRedBorder = "#FECACA";

  const txId = getTransactionId(tx);
  const txDate = getTransactionDate(tx);
  const txLabel = getTransactionLabel(tx);
  const direction = getTransactionDirection(tx);
  const amountMinor = Math.abs(getAmountMinor(tx));
  const reference = getReference(tx);
  const narration = getNarration(tx);
  const dateLabel = new Date(txDate).toLocaleString("en-NG");
  const balanceAfterLabel = balanceAfterMinor !== undefined ? formatNaira(balanceAfterMinor) : "—";

  const isCredit = direction === "CREDIT";
  const amountColor = isCredit ? emerald : red;
  const amountStrong = isCredit ? emeraldStrong : "#991B1B";
  const heroBgColor = isCredit ? heroBg : heroRedBg;
  const heroBorderColor = isCredit ? heroBorder : heroRedBorder;

  const logo = await loadLogoAsset();
  let y = 48;

  function setFont(size: number, bold = false, color: string = navy) {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(color);
  }

  function drawLogo() {
    const logoMaxW = 110;
    const logoMaxH = 36;
    let logoW = 90;
    let logoH = 30;
    if (logo) {
      const ratio = Math.min(logoMaxW / logo.width, logoMaxH / logo.height);
      logoW = logo.width * ratio;
      logoH = logo.height * ratio;
    }
    const logoX = pageWidth - margin - logoW;
    const logoY = 44;
    if (logo) {
      try {
        doc.addImage(logo.dataUrl, "PNG", logoX, logoY, logoW, logoH, undefined, "FAST");
      } catch (_e) {
        setFont(18, true, navy);
        doc.text("VELO", logoX + logoW, logoY + logoH / 2 + 6, { align: "right" });
      }
    } else {
      setFont(18, true, navy);
      doc.text("VELO", logoX + logoW, logoY + logoH / 2 + 6, { align: "right" });
    }
  }

  drawLogo();

  y += 18;
  setFont(20, true, navy);
  doc.text("Transaction details", margin, y);
  y += 14;
  setFont(11, false, slate);
  doc.text(`Reference • ${reference}`, margin, y);
  y += 30;

  const heroH = 108;
  const heroR = 16;
  doc.setFillColor(heroBgColor);
  doc.setDrawColor(heroBorderColor);
  doc.setLineWidth(0.8);
  doc.roundedRect(margin, y, contentWidth, heroH, heroR, heroR, "FD");

  setFont(11, true, slate);
  doc.text(`WALLET ${isCredit ? "CREDIT" : "DEBIT"}`, margin + 28, y + 34);
  setFont(28, true, navy);
  doc.text(txLabel, margin + 28, y + 70);

  const amountText = (isCredit ? "+" : "−") + formatNaira(amountMinor);
  setFont(10, true, slate);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(28);
  doc.setTextColor(amountStrong);
  doc.text(amountText, pageWidth - margin - 28, y + 66, { align: "right" });
  doc.setTextColor(navy);
  y += heroH + 24;

  const cardR = 14;
  const cardH = 100;
  const cardPadX = 20;
  const cardPadY = 22;
  const gap = 18;
  const half = (contentWidth - gap) / 2;

  function drawCard(x: number, cY: number, title: string, valueLines: string[]) {
    doc.setFillColor(cardBg);
    doc.setDrawColor(cardBorder);
    doc.setLineWidth(0.6);
    doc.roundedRect(x, cY, half, cardH, cardR, cardR, "FD");
    setFont(11, true, slate);
    doc.text(title, x + cardPadX, cY + cardPadY);
    setFont(13, true, navy);
    let textY = cY + cardPadY + 24;
    valueLines.forEach((line, i) => {
      if (i === 0) setFont(13, true, navy);
      else setFont(13, false, navy);
      doc.text(line, x + cardPadX, textY);
      textY += 18;
    });
  }

  drawCard(margin, y, "DATE & TIME", [dateLabel]);
  drawCard(margin + half + gap, y, "TYPE", [txLabel]);
  y += cardH + gap;

  const refLines = doc.splitTextToSize(reference, half - cardPadX - 10) as string[];
  const refH = Math.max(cardH, 80 + refLines.length * 18);
  function drawTallCard(x: number, cY: number, height: number, title: string, valueLines: string[]) {
    doc.setFillColor(cardBg);
    doc.setDrawColor(cardBorder);
    doc.setLineWidth(0.6);
    doc.roundedRect(x, cY, half, height, cardR, cardR, "FD");
    setFont(11, true, slate);
    doc.text(title, x + cardPadX, cY + cardPadY);
    setFont(13, true, navy);
    let textY = cY + cardPadY + 24;
    valueLines.forEach((line, i) => {
      if (i === 0) setFont(13, true, navy);
      else setFont(13, false, navy);
      doc.text(line, x + cardPadX, textY);
      textY += 18;
    });
  }

  drawTallCard(margin, y, refH, "REFERENCE ID", refLines);
  drawTallCard(margin + half + gap, y, refH, "WALLET BALANCE AFTER", [balanceAfterLabel]);
  y += refH + gap;

  const narrLines = doc.splitTextToSize(narration, contentWidth - cardPadX * 2) as string[];
  const narrH = 80 + narrLines.length * 18;
  doc.setFillColor(cardBg);
  doc.setDrawColor(cardBorder);
  doc.setLineWidth(0.6);
  doc.roundedRect(margin, y, contentWidth, narrH, cardR, cardR, "FD");
  setFont(11, true, slate);
  doc.text("NARRATION", margin + cardPadX, y + cardPadY);
  setFont(13, true, navy);
  let narrY = y + cardPadY + 24;
  narrLines.forEach((line) => {
    doc.text(line, margin + cardPadX, narrY);
    narrY += 18;
  });
  y += narrH + 40;

  const footerY = 770;
  doc.setDrawColor(cardBorder);
  doc.setLineWidth(0.5);
  doc.line(margin, footerY, pageWidth - margin, footerY);
  setFont(9, false, slate);
  doc.text(`${config.companyName} · Official receipt · ${txId.slice(0, 8)}`, margin, footerY + 20);
  setFont(9, false, slate);
  doc.text(`${config.companyWebsite} · support@velocredit.ng`, margin, footerY + 34);

  setFont(9, false, slate);
  doc.text("Generated: " + new Date().toLocaleDateString("en-NG"), pageWidth - margin, footerY + 20, { align: "right" });
  setFont(9, false, slate);
  doc.text("CBN Regulated · NDIC Insured", pageWidth - margin, footerY + 34, { align: "right" });

  return doc;
}
