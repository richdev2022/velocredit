const fs = require('fs');
let content = fs.readFileSync('backend/server/routes.ts', 'utf8');

// Find the email import - check first 5000 chars
const firstChunk = content.slice(0, 5000);
const emailImportIdx = firstChunk.indexOf('from "./email.js"');
console.log("email import at idx:", emailImportIdx);
if (emailImportIdx >= 0) {
  const startImport = firstChunk.lastIndexOf("import ", emailImportIdx);
  const endImport = emailImportIdx + 'from "./email.js"'.length;
  console.log("Email import content:");
  console.log(JSON.stringify(firstChunk.slice(startImport, endImport)));
} else {
  console.log("WARNING: email.js not imported!");
}
