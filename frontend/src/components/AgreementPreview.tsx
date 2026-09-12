// ============================================================================
// src/components/AgreementPreview.tsx
// On-screen preview of the generated agreement. Styled with print-friendly CSS.
// ============================================================================

import { useEffect, useRef, useState } from "react";

interface AgreementPreviewProps {
  html: string;
  onReadToEnd?: (read: boolean) => void;
}

export default function AgreementPreview({ html, onReadToEnd }: AgreementPreviewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [readToEnd, setReadToEnd] = useState(false);

  function handlePrint() {
    const images = Array.from(contentRef.current?.querySelectorAll("img") ?? []);
    const waitForImages = images.map((image) => image.complete
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      }));

    void Promise.all(waitForImages).then(async () => {
      await document.fonts?.ready;
      document.body.classList.add("printing-agreement");
      window.addEventListener("afterprint", () => document.body.classList.remove("printing-agreement"), { once: true });
      window.print();
    });
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
      <div className="no-print flex items-center justify-between px-4 sm:px-5 py-3 border-b border-slate-100 bg-slate-50/50">
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
        className="agreement-print max-h-[70vh] overflow-y-auto p-4 sm:p-6 bg-white text-[13px] leading-relaxed text-slate-700 agreement-content"
        dangerouslySetInnerHTML={{ __html: agreementCss() + html }}
      />
      <div className="no-print border-t border-slate-100 px-4 py-2 text-xs text-slate-500" aria-live="polite">
{readToEnd ? "You have reviewed the complete agreement." : "Review the complete agreement to enable acknowledgement."}
      </div>
    </div>
  );
}

function agreementCss(): string {
  return `<style>
    .agreement-doc { font-family: 'Poppins', system-ui, -apple-system, sans-serif; color: #1f2937; line-height: 1.65; }
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
    }
    .agr-h2 .bar {
      position: absolute; left: 0; top: 7px; bottom: 8px;
      width: 4px; background: #1976D2; border-radius: 2px;
    }
    .agr-h3 { font-size: 13px; font-weight: 700; color: #1976D2; margin: 10px 0 6px; }
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
    }
    .party-lender { background: #E3F2FD; }
    .party-borrower { background: #F0F9FF; }
    .pn-name { font-weight: 700; color: #0C2947; font-size: 14px; }
    .pn-url { color: #1976D2; font-size: 12.5px; }
    .pn-desc { font-size: 12.5px; color: #475569; margin-top: 2px; }
    .pn-line { font-size: 12.5px; color: #334155; margin: 2px 0; }
    .pn-line strong { color: #0C2947; }
    .pn-sub { font-size: 12px; color: #475569; margin: 4px 0; }

    .collateral-card { background: #F8FAFC; border: 1px solid #D7E0EA; border-radius: 8px; padding: 12px 14px; margin: 10px 0 14px; }
    .collateral-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 8px; }
    .collateral-grid span { display: block; color: #64748b; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
    .collateral-grid strong { display: block; color: #0C2947; font-size: 12px; margin-top: 2px; }

    .summary {
      background: #E3F2FD; padding: 12px 16px;
      border-radius: 10px; margin: 10px 0;
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
    .exec-lender, .exec-borrower, .exec-witness { break-inside: avoid; }
    .exec-lender { margin-bottom: 12px; }
    .lender-brand-panel {
      display: flex; flex-direction: column; align-items: flex-start;
      gap: 4px; padding: 14px 18px;
      background: #E3F2FD; border-radius: 8px;
      margin: 10px 0 16px;
      width: min(100%, 280px);
    }
    .exec-logo { height: 44px; max-height: 44px; width: auto; object-fit: contain; margin-bottom: 6px; }
    .lender-brand-name { font-weight: 700; color: #0C2947; font-size: 14px; }
    .lender-brand-line { font-weight: 600; color: #1976D2; font-size: 11px; }
    .lender-brand-url { font-size: 11px; color: #475569; }

    .sign-block {
      clear: both; margin: 16px 0 14px; max-width: 360px;
      padding-top: 6px;
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
    }
    .en-title { font-weight: 700; color: #0C2947; font-size: 14px; margin-bottom: 8px; }
    .en-desc { font-weight: 600; color: #334155; font-size: 11.5px; margin-bottom: 6px; }
    .en-foot { font-weight: 700; color: #0C2947; font-size: 11px; }

    .agreement-content { word-break: break-word; overflow-wrap: break-word; }
    .agreement-media { display: block; max-width: 260px; max-height: 220px; object-fit: contain; border: 1px solid #CBD5E1; border-radius: 6px; margin: 8px 0; break-inside: avoid; }
    .agreement-media-link { display: inline-block; color: #1976D2; font-size: 12px; font-weight: 600; margin: 8px 0; text-decoration: underline; }
    .media-placeholder { color: #64748b; font-size: 11px; font-style: italic; margin: 8px 0; }

  </style>`;
}
