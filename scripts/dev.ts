import { spawn } from "node:child_process";
import { resolve } from "node:path";

const processes = [
  spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "watch", "backend/server/index.ts"], {
    stdio: "inherit",
  }),
  spawn(process.execPath, [resolve("node_modules/vite/bin/vite.js")], { stdio: "inherit" }),
];

console.log("Starting Velo development servers...");
console.log("  Web:     http://localhost:5173/");
console.log("  API:     http://localhost:4000/api/v1");
console.log("  Swagger: http://localhost:4000/docs");
console.log("  Health:  http://localhost:4000/health");

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes) child.kill(signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

for (const child of processes) {
  child.on("exit", (code) => {
    if (!shuttingDown && code && code !== 0) {
      shutdown("SIGTERM");
      process.exitCode = code;
    }
  });
}
