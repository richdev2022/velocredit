const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/InvestorDashboard.tsx', 'utf8');

// Find and insert liveness section after the NIN grid-cols-2 div
const ninGridEndMarker = `                </div>
                  <label className="velo-label block">
                    Proof of address`;

const idx = content.indexOf(ninGridEndMarker);
console.log("Proof of address idx:", idx);

if (idx >= 0) {
  const livenessSection = `                </div>

                <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-800/50 dark:bg-emerald-900/10">
                  <h3 className="mb-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300">Liveness verification <span className="text-red-500">*</span></h3>
                  <p className="mb-3 text-xs text-emerald-700 dark:text-emerald-300/80">Complete a quick in-app selfie scan using our identity verification widget (recommended &amp; primary method).</p>
                  <div className="flex flex-wrap items-center gap-3">
                    <PremblyKycWidgetButton
                      fullName={user?.fullName}
                      email={user?.email}
                      phone={user?.phone}
                      idType={checklist.bvn ? "BVN" : "NIN"}
                      idNumber={bvn || nin || ""}
                      onResult={onPremblyLivenessResult}
                    />
                    {checklist.selfieUploaded && <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">\u2713 Liveness verified</span>}
                  </div>
                  <div className="mt-4 border-t border-emerald-200/70 pt-3 dark:border-emerald-700/40">
                    <details className="group">
                      <summary className="cursor-pointer text-xs font-medium text-slate-600 hover:text-slate-800 dark:text-slate-300 dark:hover:text-white">Having trouble with the camera? Click here to upload a selfie instead (fallback).</summary>
                      <div className="mt-2">
                        <label className="velo-label text-xs">
                          Upload live selfie
                          <input className="velo-input mt-1" type="file" accept="image/jpeg,image/png,image/webp" disabled={kycBusy === "LIVENESS_FILE"} onChange={(event) => { const file = event.target.files?.[0]; if (file) void verifyLivenessFile(file); }} />
                        </label>
                      </div>
                    </details>
                  </div>
                </div>

                <label className="velo-label block">
                    Proof of address`;

  content = content.slice(0, idx) + livenessSection + content.slice(idx + ninGridEndMarker.length);
  console.log("SUCCESS: Liveness section added to investor dashboard");
  fs.writeFileSync('frontend/src/pages/InvestorDashboard.tsx', content);
} else {
  console.log("ERROR: Could not find insertion point");
  const idxGridEnd = content.indexOf("</div>\n                  <label className=\"velo-label block\">");
  console.log("Alternate grid end at:", idxGridEnd);
  const idxProof = content.indexOf("Proof of address");
  console.log("'Proof of address' at:", idxProof);
}
