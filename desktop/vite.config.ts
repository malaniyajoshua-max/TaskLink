import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { randomBytes } from "node:crypto";
export default defineConfig(({ command }) => {
  const nonce = randomBytes(18).toString("base64");
  return {
    base: "./",
    plugins: [react(), tailwindcss()],
    html: command === "serve" ? { cspNonce: nonce } : undefined,
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      headers: {
        "Content-Security-Policy": "script-src 'self' 'nonce-" + nonce + "'",
      },
    },
  };
});
