const fs = require('fs');
let content = fs.readFileSync('frontend/src/components/admin/AdminSettings.tsx', 'utf8');

// 1. Add useEffect import
if (!content.includes('import { useMemo, useState, useEffect } from "react"')) {
  content = content.replace(
    'import { useMemo, useState } from "react";',
    'import { useEffect, useMemo, useState } from "react";'
  );
  console.log("✅ Added useEffect import");
} else {
  console.log("useEffect already imported");
}

// 2. Add adminApi imports
if (!content.includes('adminGetPlatformSettings')) {
  const oldAdminImport = 'import { adminResetConfig, adminSaveConfig } from "../../services/adminApi";';
  const newAdminImport = `import {
  adminGetPlatformSettings,
  adminUpdatePlatformSettings,
  adminSetInvestorEarningRate,
  adminCreditInvestorWallet,
  adminGetLedger,
  adminListInvestors,
  adminListWithdrawals,
  adminApproveWithdrawal,
  adminRejectWithdrawal,
} from "../../services/adminApi";`;
  if (content.includes(oldAdminImport)) {
    content = content.replace(oldAdminImport, newAdminImport);
    console.log("✅ Added admin API imports");
  } else {
    console.log("⚠️  adminApi import pattern not found");
  }
} else {
  console.log("Admin API imports already present");
}

// 3. Add state and handlers after last useState declaration
const lastStateMarker = 'const [resetConfirm, setResetConfirm] = useState(false);';
const stateIdx = content.indexOf(lastStateMarker);
console.log("lastStateMarker idx:", stateIdx);

if (stateIdx >= 0 && !content.includes('handleSavePlatformSettings')) {
  const insertPos = stateIdx + lastStateMarker.length;
  
  const handlersCode = fs.readFileSync('investor_settings_handlers.txt', 'utf8');
  content = content.slice(0, insertPos) + handlersCode + content.slice(insertPos);
  console.log("✅ Added state handlers and hooks");
} else if (content.includes('handleSavePlatformSettings')) {
  console.log("State handlers already added");
}

// 4. Insert new settings sections before closing return grid layout
const newSections = fs.readFileSync('investor_settings_insertion.txt', 'utf8')
  .replace('__MARKER_START_NEW_SECTIONS__\n', '')
  .replace('\n__MARKER_END_NEW_SECTIONS__', '');

// Find end of grid and preview sections - find the pattern: closing div of lg:col-span-3 grid 
// Look for the very end return block
if (!content.includes('Admin Ledger Activity') && !content.includes('Pending Investor Withdrawals')) {
  const returnEndIdx = content.lastIndexOf("</div>\n  );\n}");
  console.log("return end idx:", returnEndIdx);
  
  if (returnEndIdx > 0) {
    // Find the grid closing div BEFORE this end point
    // We need to insert BEFORE the closing </div> that closes the `lg:grid-cols-3 gap-6`
    // Look backwards from returnEndIdx for the section structure
    let searchPos = returnEndIdx - 5;
    // Count closing divs to find the right insertion point
    // The pattern is: </div>\n  );\n} - this closes the animate-fade-in wrapper
    // The grid closes with: </div>\n\n    </div>\n  );
    
    // Strategy: look for the 2-space-indented closing that closes the 3-col grid
    let insertPosition = -1;
    // Look for pattern: sidebar preview closing before final closing divs
    // Look backwards for the pattern that closes the col-span-1 sidebar
    const pattern1 = "</div>\n  );\n}";
    if (content.slice(returnEndIdx, returnEndIdx + pattern1.length) === pattern1) {
      // Now go back and find the grid wrap close
      // The 3-col grid has pattern: grid div open -> ... -> grid div close -> animate div close -> return close
      // Let's count 3 levels of </div> backwards
      let remaining = 3;
      let cur = returnEndIdx;
      while (cur > 0 && remaining > 0) {
        const found = content.lastIndexOf("</div>", cur - 1);
        if (found < 0) break;
        cur = found;
        remaining--;
        if (remaining === 0) insertPosition = found;
      }
      console.log("Insert position (before grid-closing </div>):", insertPosition);
      if (insertPosition > 0) {
        // Check if there's already new-style content
        const beforeInsert = content.slice(0, insertPosition);
        const afterInsert = content.slice(insertPosition);
        content = beforeInsert + "\n\n" + newSections + "\n" + afterInsert;
        console.log("✅ New settings sections inserted successfully");
      }
    }
  }
} else {
  console.log("New sections already present");
}

fs.writeFileSync('frontend/src/components/admin/AdminSettings.tsx', content);
console.log("\n✅ AdminSettings.tsx patched");
