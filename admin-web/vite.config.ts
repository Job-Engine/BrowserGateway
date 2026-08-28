import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The console talks to the gateway. In dev we proxy the gateway paths to the
// local gateway (default http://localhost:8080) so the browser makes
// same-origin requests and never trips CORS. Override the target with
// GATEWAY_ORIGIN when the gateway runs elsewhere.
const target = process.env.GATEWAY_ORIGIN ?? "http://localhost:8080";
const proxy = Object.fromEntries(
  ["/admin", "/jobs", "/health", "/catalogue", "/openapi.json"].map((path) => [
    path,
    { target, changeOrigin: true },
  ]),
);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
});
