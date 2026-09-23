// ============================================================================
// src/components/AgreementPreview.tsx
// On-screen preview of the generated agreement + bullet-proof A4 printing.
//
// PRINTING (v2): the old implementation used the "visibility:hidden on #root"
// trick with window.print(). Hidden elements still OCCUPY LAYOUT SPACE, so
// every page outside the agreement printed as a BLANK PAGE — and ancestor
// scroll containers could clip content mid-page. The new implementation prints
// from a dedicated hidden <iframe> loaded with a STANDALONE document:
//   • @page { size: A4 portrait } — exact A4 geometry, browser-independent
//   • zero interference from app layout (no blank pages, no clipping)
//   • images + fonts awaited before the dialog opens
//   • print-color-adjust so brand panels still render in the PDF
// The same component is used by the borrower flow AND the admin detail page,
// so both sides get identical, correct output.
// ============================================================================

import { useEffect, useRef, useState } from "react";

interface AgreementPreviewProps {
  html: string;
  onReadToEnd?: (read: boolean) => void;
}

/** A4 at 96dpi — used for the off-screen iframe so % widths resolve correctly. */
const A4_WIDTH_PX = 794;
const A4_HEIGHT_PX = 1123;

export default function AgreementPreview({ html, onReadToEnd }: AgreementPreviewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [readToEnd, setReadToEnd] = useState(false);

  function handlePrint() {
    printHtmlAsA4(html);
  }

  useEffect(() => {
    setReadToEnd(false);
    onReadToEnd?.(false);
    const content = contentRef.current;
    if (!content) return;
    const updateReadState = () => {
      const read = content.scrollTop + content.clientHeight >= content.scrollHeight - 8;
      setReadToEnd(read);
      onReadToEnd?.(read);
    };
    updateReadState();
    content.addEventListener("scroll", updateReadState, { passive: true });
    return () => content.removeEventListener("scroll", updateReadState);
  }, [html, onReadToEnd]);

  return (
    <div className="agreement-print-target velo-card overflow-hidden">
      <div className="no-print flex items-center justify-between px-4 sm:px-5 py-3 border-b border-slate-100 bg-slate-50/50 dark:border-slate-700 dark:bg-slate-900">
        <div>
          <h3 className="text-sm font-semibold text-velo-900">Agreement Preview</h3>
          <p className="text-xs text-slate-500">Scroll to read the complete agreement before continuing.</p>
        </div>
        <button type="button" className="btn-secondary text-xs" onClick={handlePrint}>
          Print full agreement
        </button>
      </div>
      <div
        ref={contentRef}
        className="agreement-print max-h-[70vh] overflow-y-auto p-4 sm:p-6 bg-white text-[13px] leading-relaxed text-slate-700 agreement-content dark:bg-slate-950 dark:text-slate-200"
        dangerouslySetInnerHTML={{ __html: `<style>${agreementCssText()}</style>` + html }}
      />
      <div className="no-print border-t border-slate-100 px-4 py-2 text-xs text-slate-500" aria-live="polite">
{readToEnd ? "You have reviewed the complete agreement." : "Review the complete agreement to enable acknowledgement."}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A4 print engine (shared): loads `html` into a hidden iframe as a standalone
// document and prints it. Resolves when the print dialog has been dismissed
// (or after a generous fallback timeout). Safe to call from anywhere.
// ---------------------------------------------------------------------------

export function printHtmlAsA4(html: string, documentTitle = "Loan Agreement"): void {
  const previousTitle = document.title;
  document.title = documentTitle;

  const iframe = document.createElement("iframe");
  // Off-screen but rendered (display:none would make some browsers skip print
  // layout). Sized to A4 so percentage-based content lays out like the paper.
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = `${A4_WIDTH_PX}px`;
  iframe.style.height = `${A4_HEIGHT_PX}px`;
  iframe.style.border = "0";
  iframe.style.visibility = "hidden";
  iframe.style.zIndex = "-1";

  let cleanupDone = false;
  const cleanup = () => {
    if (cleanupDone) return;
    cleanupDone = true;
    document.title = previousTitle;
    window.removeEventListener("afterprint", onAfterPrint);
    window.setTimeout(() => iframe.remove(), 200);
  };
  const onAfterPrint = () => cleanup();
  window.addEventListener("afterprint", onAfterPrint);

  iframe.onload = () => {
    const doc = iframe.contentDocument;
    if (!doc) {
      cleanup();
      return;
    }
    const images = Array.from(doc.querySelectorAll("img"));
    const waitForImages = images.map((image) => image.complete
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => resolve(), { once: true });
      }));
    void Promise.all([
      ...waitForImages,
      (iframe.contentWindow as (Window & { fonts?: { ready: Promise<unknown> } }) | null)?.fonts?.ready ?? Promise.resolve(),
    ]).then(() => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } finally {
        // Some browsers never fire `afterprint` for iframe printing — make sure
        // the iframe is always removed.
        window.setTimeout(cleanup, 60_000);
      }
    });
  };

  iframe.srcdoc = buildAgreementPrintDocument(html);
  document.body.appendChild(iframe);
}

/** Builds the standalone, print-ready A4 document for an agreement fragment. */
export function buildAgreementPrintDocument(html: string, documentTitle = "Loan Agreement"): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${documentTitle}</title>
<style>
  ${agreementCssText()}
  /* ===== STANDALONE PAGE GEOMETRY ===== */
  @page {
    size: A4 portrait;
    margin: 14mm 12mm 16mm 12mm;
  }
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    background: #ffffff !important;
  }
  body {
    width: 186mm; /* 210mm - 2×12mm margins */
    box-sizing: border-box;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  #print-root { width: 100%; }
  img { max-width: 100% !important; height: auto; }
  table { width: 100%; border-collapse: collapse; }
  tr, td, th { page-break-inside: avoid; break-inside: avoid; }
</style>
</head>
<body>
  <div id="print-root" class="agreement-doc">${html}</div>
</body>
</html>`;
}

function agreementCssText(): string {
  return `
    .agreement-doc { font-family: 'Poppins', system-ui, -apple-system, sans-serif; color: #1f2937; line-height: 1.65; }
    .dark .agreement-doc { color: #e2e8f0; }
    .dark .agreement-doc .agr-p, .dark .agreement-doc .pn-line { color: #cbd5e1; }
    .dark .agreement-doc .agr-h1, .dark .agreement-doc .agr-h2, .dark .agreement-doc strong, .dark .agreement-doc b, .dark .agreement-doc .val, .dark .agreement-doc .pn-name, .dark .agreement-doc .sr-val { color: #f8fafc; }
    .dark .agreement-doc .agr-header, .dark .agreement-doc .party-lender, .dark .agreement-doc .summary, .dark .agreement-doc .lender-brand-panel, .dark .agreement-doc .end-note { background: #17243d; }
    .dark .agreement-doc .party-borrower, .dark .agreement-doc .collateral-card { background: #1e293b; border-color: #475569; }
    .dark .agreement-doc .agr-sub-title, .dark .agreement-doc .agr-meta, .dark .agreement-doc .pn-desc, .dark .agreement-doc .pn-sub, .dark .agreement-doc .collateral-grid span, .dark .agreement-doc .media-placeholder { color: #94a3b8; }
    .dark .agreement-doc .sr-row { border-color: #334155; }
    .agreement-doc strong, .agreement-doc b { font-weight: 700; color: #0C2947; }
    .agreement-doc .val { font-weight: 700; color: #0C2947; }
    .agreement-doc .val-emph { font-weight: 700; color: #B91C1C; }

    .agr-header {
      display: flex; justify-content: space-between; align-items: flex-start;
      background: #E3F2FD; padding: 16px 18px; border-radius: 8px;
      margin-bottom: 24px; border-top: 4px solid #1976D2;
    }
    .agr-logo { height: 52px; max-height: 52px; width: auto; display: block; object-fit: contain; }
    .agr-brand { display: flex; align-items: center; gap: 12px; }
    .agr-brand-mark {
      display: inline-flex; align-items: center; justify-content: center;
      height: 44px; width: 44px; border-radius: 8px;
      background: #1976D2; color: #fff;
      font-weight: 800; font-size: 22px;
      box-shadow: 0 2px 6px rgba(33,150,243,0.25);
    }
    .agr-brand-text { font-weight: 700; color: #0C2947; font-size: 16px; }
    .agr-meta { font-size: 12px; color: #64748b; text-align: right; line-height: 1.6; }
    .agr-meta strong { color: #0C2947; font-weight: 700; font-size: 13px; }

    .agr-title-block { text-align: center; margin: 0 0 18px; }
    .agr-h1 {
      font-size: 24px; font-weight: 800; color: #0C2947;
      margin: 0 0 8px; letter-spacing: -0.01em;
    }
    .agr-sub-title {
      font-size: 13px; color: #475569; margin: 0;
    }

    .agr-h2 {
      font-size: 15px; font-weight: 700; color: #0C2947;
      margin: 24px 0 12px; padding: 6px 0 8px 18px;
      border-bottom: 1px solid #E2E8F0;
      position: relative;
      display: flex; align-items: center;
      break-after: avoid;
      page-break-after: avoid;
    }
    .agr-h2 .bar {
      position: absolute; left: 0; top: 7px; bottom: 8px;
      width: 4px; background: #1976D2; border-radius: 2px;
    }
    .agr-h3 { font-size: 13px; font-weight: 700; color: #1976D2; margin: 10px 0 6px; break-after: avoid; page-break-after: avoid; }
    .agr-p { margin: 6px 0; font-size: 13px; text-align: justify; color: #334155; }
    .agr-p.vline { color: #0f172a; }
    .agr-p.vline b { color: #334155; }
    .agr-ul { padding-left: 20px; list-style: disc; margin: 4px 0 8px; font-size: 12.5px; }
    .agr-ul li { margin: 2px 0; }
    .agr-hr { border: 0; border-top: 1px solid #CBD5E1; margin: 20px 0; }
    .agr-endnote { text-align: center; font-weight: 600; color: #0C2947; margin-top: 16px; font-size: 13px; }

    .parties { display: flex; flex-direction: column; gap: 14px; margin: 10px 0 6px; }
    .party-lender, .party-borrower {
      padding: 14px 16px; border-radius: 8px;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .party-lender { background: #E3F2FD; }
    .party-borrower { background: #F0F9FF; }
    .pn-name { font-weight: 700; color: #0C2947; font-size: 14px; }
    .pn-url { color: #1976D2; font-size: 12.5px; }
    .pn-desc { font-size: 12.5px; color: #475569; margin-top: 2px; }
    .pn-line { font-size: 12.5px; color: #334155; margin: 2px 0; }
    .pn-line strong { color: #0C2947; }
    .pn-sub { font-size: 12px; color: #475569; margin: 4px 0; }

    .collateral-card { background: #F8FAFC; border: 1px solid #D7E0EA; border-radius: 8px; padding: 12px 14px; margin: 10px 0 14px; break-inside: avoid; page-break-inside: avoid; }
    .collateral-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 8px; }
    .collateral-grid span { display: block; color: #64748b; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
    .collateral-grid strong { display: block; color: #0C2947; font-size: 12px; margin-top: 2px; }

    .summary {
      background: #E3F2FD; padding: 12px 16px;
      border-radius: 10px; margin: 10px 0;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .sr-row {
      display: flex; justify-content: space-between; align-items: flex-start;
      padding: 7px 2px; gap: 14px;
      border-bottom: 1px solid #BBDEFB;
    }
    .sr-row:last-child { border-bottom: 0; }
    .sr-key { font-weight: 700; font-size: 13px; color: #334155; }
    .sr-val {
      font-weight: 700; font-size: 13.5px; color: #0C2947;
      text-align: right; max-width: 55%; word-break: break-word;
    }
    .sr-val .val-emph { color: #B91C1C; font-weight: 800; }

    .page-break { page-break-before: always; margin-top: 30px; }

    .exec-grid { display: flex; flex-direction: column; gap: 8px; }
    .exec-lender, .exec-borrower, .exec-witness { break-inside: avoid; page-break-inside: avoid; }
    .exec-lender { margin-bottom: 12px; }
    .lender-brand-panel {
      display: flex; flex-direction: column; align-items: flex-start;
      gap: 4px; padding: 14px 18px;
      background: #E3F2FD; border-radius: 8px;
      margin: 10px 0 16px;
      width: min(100%, 280px);
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .exec-logo { height: 44px; max-height: 44px; width: auto; object-fit: contain; margin-bottom: 6px; }
    .lender-brand-name { font-weight: 700; color: #0C2947; font-size: 14px; }
    .lender-brand-line { font-weight: 600; color: #1976D2; font-size: 11px; }
    .lender-brand-url { font-size: 11px; color: #475569; }

    .sign-block {
      clear: both; margin: 16px 0 14px; max-width: 360px;
      padding-top: 6px;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .sign-line {
      width: 240px; border-bottom: 1px solid #475569;
      margin: 8px 0 10px;
    }
    .sign-label { font-weight: 700; font-size: 12.5px; color: #0C2947; margin: 4px 0; }
    .sign-sub { font-size: 11.5px; color: #475569; margin: 2px 0; }
    .sign-date { font-size: 12px; color: #475569; margin-top: 10px; }

    .blank-field {
      display: flex; align-items: center; gap: 8px;
      font-size: 12.5px; font-weight: 600; color: #0C2947;
      margin: 6px 0 12px;
      width: 100%;
    }
    .blank-underline {
      flex: 1; max-width: 260px;
      border-bottom: 1px solid #94A3B8; height: 10px;
    }

    .end-note {
      margin: 40px 0 10px;
      background: #E3F2FD;
      padding: 18px 18px;
      border-radius: 8px;
      text-align: center;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .en-title { font-weight: 700; color: #0C2947; font-size: 14px; margin-bottom: 8px; }
    .en-desc { font-weight: 600; color: #334155; font-size: 11.5px; margin-bottom: 6px; }
    .en-foot { font-weight: 700; color: #0C2947; font-size: 11px; }

    .agreement-content { word-break: break-word; overflow-wrap: break-word; }
    .agreement-media { display: block; max-width: 260px; max-height: 220px; object-fit: contain; border: 1px solid #CBD5E1; border-radius: 6px; margin: 8px 0; break-inside: avoid; page-break-inside: avoid; }
    .agreement-media-link { display: inline-block; color: #1976D2; font-size: 12px; font-weight: 600; margin: 8px 0; text-decoration: underline; }
    .media-placeholder { color: #64748b; font-size: 11px; font-style: italic; margin: 8px 0; }

    /* ===== SCREEN PRESENTATION ===== */
    /* On screen the document is rendered inside the scrollable preview; the
       standalone iframe document applies its own page geometry. */
    .agreement-doc { font-size: 13px; }

    /* ===== A4 PRINT RULES (apply inside the print iframe too) ===== */
    @media print {
      html, body {
        background: #fff !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      body.printing-agreement .no-print { display: none !important; }
      /* Headings stay with their following content. */
      .agr-h1, .agr-h2, .agr-h3 {
        page-break-after: avoid;
        break-after: avoid;
      }
      .agr-p,
      .pn-line,
      .sr-row { page-break-inside: avoid; }
      /* No orphaned section titles at the bottom of a page. */
      .agr-title-block,
      .summary,
      .collateral-card,
      .party-lender,
      .party-borrower,
      .lender-brand-panel,
      .end-note,
      .sign-block {
        page-break-inside: avoid;
        break-inside: avoid;
      }
      /* Force the execution/signature page onto its own sheet when the
         agreement body fills the previous pages. */
      .page-break { page-break-before: always; }
      /* Images always fit within the printable width. */
      .agreement-media { max-width: 100% !important; max-height: 180px !important; }
      .agr-logo, .exec-logo { max-height: 44px !important; }
    }
  `;
}
