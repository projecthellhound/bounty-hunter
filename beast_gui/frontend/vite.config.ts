import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The built app is served by the FastAPI backend (beast_gui/backend/server.py)
// from ./dist. In dev, `npm run dev` proxies /api and /ws to that backend so
// the frontend talks to the real agent, not a mock.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
