const fs = require("fs");
const path = require("path");

const filePath = path.join(
  process.cwd(),
  "frontend",
  "src",
  "components",
  "admin",
  "AdminSettings.tsx"
);

console.log("Reading:", filePath);
let content = fs.readFileSync(filePath, "utf8");
const lines = content.split(/\r?\n/);

console.log("Total lines:", lines.length);

// FeeField function structure (1-indexed line numbers from earlier reads):
// Line 878 opens: flex items-center gap-2 div
// Lines 897: </span>
// Lines 898-899: blank
// Lines 900-1302: INJECTED CONTENT (wrong location)
// Line 1303: </div> (closes flex div)
// Lines 1304-1312: includeUpfront label checkbox
// Line 1313: </div> (space-y)
// Line 1314: </div> (outer div)
// Line 1315: );
// Line 1316: }

// Correct injection point in AdminSettings:
// Line 789: </div> (closes lg:grid-cols-3)
// Line 790: blank
// Line 791: {/* Bottom sticky save bar */}

// 0-indexed arrays: subtract 1
const FLEX_DIV_OPEN = 878 - 1;
const SPAN_CLOSE_LINE = 897 - 1; // index 896: line 897 </span>
const INJECTION_START = 900 - 1; // index 899 (line 900)
const INJECTION_END = 1302 - 1; // index 1301 (line 1302)
const FLEX_DIV_CLOSE = 1303 - 1; // index 1302 (line 1303: </div>)
const LABEL_START = 1304 - 1; // index 1303
const LABEL_END = 1312 - 1; // index 1311
const SPACEY_DIV_CLOSE = 1313 - 1; // index 1312
const OUTER_DIV_CLOSE = 1314 - 1; // index 1313
const RETURN_CLOSE = 1315 - 1; // index 1314
const FUNC_CLOSE = 1316 - 1; // index 1315

const GRID_CLOSE = 789 - 1; // index 788 (line 789 </div>)
const BLANK_BEFORE_SAVEBAR = 790 - 1; // index 789
const SAVEBAR_START = 791 - 1; // index 790

// Extract the injected content (lines 900-1302 inclusive, 0-index 899..1301)
const injectedContent = lines.slice(INJECTION_START, INJECTION_END + 1);
console.log(
  "Extracted injected lines:",
  injectedContent.length,
  "Starting with:",
  JSON.stringify(injectedContent[0]?.slice(0, 60))
);
console.log(
  "Last injected line:",
  JSON.stringify(injectedContent[injectedContent.length - 1]?.slice(0, 60))
);

// Extract the includeUpfront label (lines 1304-1312)
const upfrontLabel = lines.slice(LABEL_START, LABEL_END + 1);
console.log("Upfront label lines:", upfrontLabel.length);

// Now REBUILD the FeeField function properly:
// Before injection, lines up to SPAN_CLOSE (index 896, line 897) stay as-is
// Then we need to close the flex div (line 1303's content)
// Then includeUpfront label (lines 1304-1312)
// Then space-y close, outer div close, return close, func close (lines 1313-1316)

const beforeInjection = lines.slice(0, SPAN_CLOSE_LINE + 1); // lines 1..897
const closeFlexDiv = lines[FLEX_DIV_CLOSE]; // line 1303: </div>
const closeSpaceyDiv = lines[SPACEY_DIV_CLOSE];
const closeOuterDiv = lines[OUTER_DIV_CLOSE];
const closeReturn = lines[RETURN_CLOSE];
const closeFunc = lines[FUNC_CLOSE];

// After FeeField function: the rest starting from line 1317 onwards (PreviewRow etc.)
const afterFeeField = lines.slice(FUNC_CLOSE + 1);
console.log("Lines after FeeField:", afterFeeField.length);

// Build FeeField + after WITHOUT the injected content, properly closed
const feeFieldProperClose = [
  "",
  "",
  closeFlexDiv, // close flex items-center
  ...upfrontLabel, // checkbox label
  closeSpaceyDiv,
  closeOuterDiv,
  closeReturn,
  closeFunc,
];

const contentWithoutInjection = [
  ...beforeInjection,
  ...feeFieldProperClose,
  ...afterFeeField,
];
console.log(
  "Content size after removing injected content from FeeField:",
  contentWithoutInjection.length
);

// Now INSERT the injected content at the correct spot in AdminSettings return:
// Correct insertion point: AFTER line 789 (grid closes) and BEFORE line 790 blank / line 791 save bar.
// Actually we want to insert right after the grid closes. Let me insert it right at index 789 (after
// grid </div> line 789, 0-index 788 — so insert AT index 789 to put after grid).

const GRID_CLOSE_IDX = 788; // 0-indexed: line 789
const insertionPoint = GRID_CLOSE_IDX + 1; // insert after grid close

// Wrap the injected content in a new grid container to make lg:col-span classes work
const wrappedInjected = [
  "",
  "      {/* ===== Investor Management + Admin Ledger Center ===== */}",
  '      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">',
  ...injectedContent,
  "      </div>",
  "",
];

const beforeInsert = contentWithoutInjection.slice(0, insertionPoint);
const afterInsert = contentWithoutInjection.slice(insertionPoint);

const finalLines = [...beforeInsert, ...wrappedInjected, ...afterInsert];

console.log("Final total lines:", finalLines.length);

const finalContent = finalLines.join("\n");
fs.writeFileSync(filePath, finalContent, "utf8");
console.log(">> File written successfully.");
