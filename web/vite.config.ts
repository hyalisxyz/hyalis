import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the API calls go to the live backend; in production the backend serves
// this site itself, so the API is on the same origin.
const API = process.env.API_ORIGIN ?? "https://hyalis.xyz";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/v1": { target: API, changeOrigin: true }, "/health": { target: API, changeOrigin: true } } },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1200, manifest: true },
});
