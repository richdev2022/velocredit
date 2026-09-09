import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// https://vite.dev/config/
export default defineConfig({
    root: "frontend",
    envDir: "..",
    plugins: [react()],
    server: {
        port: 5173,
        host: true,
    },
});
