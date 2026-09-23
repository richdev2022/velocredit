// ============================================================================
// scripts/verifySwaggerCoverage.mjs
// Verifies that backend/server/openapi.ts documents EVERY route registered in
// backend/server/routes.ts (router.<method>("/...")) plus the app-level routes
// in backend/server/index.ts. Exits non-zero listing any missing operations.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const ROUTES = path.join(root, "backend/server/routes.ts");
const INDEX = path.join(root, "backend/server/index.ts");
const OPENAPI = path.join(root, "backend/server/openapi.ts");

// ---- 1. Extract registered routes from routes.ts ---------------------------
const routesSource = fs.readFileSync(ROUTES, "utf8");
const registered = new Map(); // "METHOD /path" -> true
const methodRegex = /router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
let match;
while ((match = methodRegex.exec(routesSource)) !== null) {
  const method = match[1].toLowerCase();
  const rawPath = match[2];
  if (!rawPath.startsWith("/")) continue; // router.use(...) etc.
  const openApiPath = `/api/v1${rawPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`; // router is mounted at /api/v1
  registered.set(`${method} ${openApiPath}`, true);
}

// App-level routes from index.ts (webhooks, health, openapi)
const indexSource = fs.readFileSync(INDEX, "utf8");
const appMethodRegex = /app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
while ((match = appMethodRegex.exec(indexSource)) !== null) {
  const method = match[1].toLowerCase();
  const openApiPath = match[2].replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  registered.set(`${method} ${openApiPath}`, true);
}

// ---- 2. Transpile openapi.ts and evaluate the spec -------------------------
const openapiSource = fs.readFileSync(OPENAPI, "utf8");
const js = ts.transpileModule(openapiSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dataUrl = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
const specModule = await import(dataUrl);
const spec = specModule.openapi ?? specModule.default ?? specModule;
const specPaths = spec?.paths ?? {};
const documented = new Set();
for (const [p, pathItem] of Object.entries(specPaths)) {
  for (const method of Object.keys(pathItem)) {
    if (["parameters", "summary", "description"].includes(method)) continue;
    documented.add(`${method.toLowerCase()} ${p}`);
  }
}

// ---- 3. Diff ----------------------------------------------------------------
const missing = [];
for (const key of registered.keys()) {
  if (!documented.has(key)) missing.push(key);
}
const extra = [];
for (const key of documented.keys()) {
  if (!registered.has(key)) extra.push(key);
}

console.log(`Registered routes (routes.ts + index.ts): ${registered.size}`);
console.log(`Documented operations (openapi.ts):       ${documented.size}`);

if (missing.length) {
  console.error(`\nMISSING from openapi.ts (${missing.length}):`);
  for (const key of missing.sort()) console.error(`  - ${key}`);
}
if (extra.length) {
  console.warn(`\nDocumented but NOT registered (${extra.length}):`);
  for (const key of extra.sort()) console.warn(`  - ${key}`);
}
if (missing.length === 0) {
  console.log("\nOK: every registered route is documented in openapi.ts");
}
process.exit(missing.length ? 1 : 0);
