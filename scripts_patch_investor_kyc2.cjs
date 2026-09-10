const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/InvestorDashboard.tsx', 'utf8');

// Use occurrence 4 at idx 22820
const proofJsxIdx = 22820;
console.log("JSX Proof of address at:", proofJsxIdx);

// Find the preceding grid div end
const precedingGridEndIdx = content.lastIndexOf("</div>", proofJsxIdx - 100);
console.log("Preceding </div> at:", precedingGridEndIdx);

// Get the 100 chars before proofJsxIdx for context
console.log("\nContext before JSX proof (idx 22720-22850):");
console.log(JSON.stringify(content.slice(22720, 22850)));

// Find exact point to insert: after NIN label section closes, before Proof of address label
// Pattern: /label>\s*<\/div>\s*<label className="velo-label block">\n\s*Proof of address/
const insertPattern = /(<\/label>\s*<\/div>)\s*(<label className="velo-label block">\s*\n\s*Proof of address)/;
const match = insertPattern.exec(content.slice(22600, 22950));
if (match) {
  console.log("\nFound insert pattern!");
  const offset = 22600;
  const absoluteStart = offset + match.index + match[1].length;
  const absoluteEnd = offset + match.index + match[1].length;
  
  const livenessBlock = `

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
                    {checklist.selfieUploaded && <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">✓ Liveness verified</span>}
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
`;
  
  content = content.slice(0, absoluteStart) + livenessBlock + content.slice(absoluteEnd);
  console.log("✅ SUCCESS: Liveness widget added to Investor dashboard");
  fs.writeFileSync('frontend/src/pages/InvestorDashboard.tsx', content);
} else {
  console.log("❌ Insert pattern not found, trying raw offset-based insert...");
  // Find the "<label className=\"velo-label block\">\n                  Proof of address" start
  const labelStart = content.indexOf('<label className="velo-label block">\n                  Proof of address', proofJsxIdx - 100);
  console.log("labelStart at:", labelStart);
  if (labelStart > 0) {
    const insertAt = labelStart;
    const livenessBlock = `                <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-800/50 dark:bg-emerald-900/10">
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
                    {checklist.selfieUploaded && <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">✓ Liveness verified</span>}
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
`;
    content = content.slice(0, insertAt) + livenessBlock + content.slice(insertAt);
    console.log("✅ SUCCESS: Liveness widget added (offset method)");
    fs.writeFileSync('frontend/src/pages/InvestorDashboard.tsx', content);
  }
}
