interface ReceiptPrintProps {
  disabled?: boolean;
}

export default function ReceiptPrint({ disabled }: ReceiptPrintProps) {
  return (
    <button
      type="button"
      onClick={() => {
        document.body.classList.add("printing-receipt");
        window.setTimeout(() => {
          window.print();
          document.body.classList.remove("printing-receipt");
        }, 0);
      }}
      disabled={disabled}
      className="no-print inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:hover:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 text-[11px] font-bold transition disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><path d="M18 12h.01" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
      <span>Print Receipt</span>
    </button>
  );
}
