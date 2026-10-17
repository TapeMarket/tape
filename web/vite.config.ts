import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { depositPinFrom } from "./deployment-pin.mjs";

// The pricing math and the EIP-712 types live in ../shared and are used by the relayer too.
export default defineConfig(({ command, mode }) => {
  const settings = { ...loadEnv(mode, fileURLToPath(new URL("./", import.meta.url)), "VITE_"), ...process.env };
  const deploymentFile = fileURLToPath(new URL("../deployments/1.json", import.meta.url));
  const pin = depositPinFrom(existsSync(deploymentFile) ? JSON.parse(readFileSync(deploymentFile, "utf8")) : null);
  const api = settings.VITE_API_URL;
  const remoteApi = api && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(api).hostname);
  if (command === "build" && settings.VITE_PREVIEW !== "1" && remoteApi && !pin) {
    throw Error("Deploy Tape's Deposits contract first. The live build requires its address in deployments/1.json so deposits are pinned independently of the API.");
  }
  return {
    plugins: [react()],
    // When this build was made. Open tabs compare it and the older ones reload themselves.
    define: { __BUILD__: JSON.stringify(Date.now()), __MAINNET_DEPOSITS__: JSON.stringify(pin) },
    resolve: { alias: { "@shared": fileURLToPath(new URL("../shared", import.meta.url)) } },
    server: { port: 5173, strictPort: true, fs: { allow: [".."] } },
    build: {
      target: "es2022",
      sourcemap: false,
      rollupOptions: {
        output: {
          // Three libraries make up nearly all of the bundle. Splitting them lets the browser fetch
          // them in parallel and keep them cached across releases of the app itself.
          manualChunks: {
            // Keep Vite's tiny shared loader separate: otherwise Rollup can put it in viem,
            // making the landing page download the whole wallet library just to preload routes.
            preload: ["\0vite/preload-helper.js"],
            react: ["react", "react-dom"],
            charts: ["lightweight-charts"],
            viem: ["viem", "viem/accounts", "viem/chains"],
          },
        },
      },
    },
  };
});
