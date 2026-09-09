import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
// https://vite.dev/config/
export default defineConfig({
    root: "frontend",
    envDir: "..",
    plugins: [react()],
    resolve: {
        alias: {
            ReactPropTypes: resolve(process.cwd(), "frontend/src/utils/premblyPropTypesShim.ts"),
        },
    },
    server: {
        port: 5173,
        host: true,
    },
});
