import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  base: "./",
  plugins: [
    nodePolyfills({
      include: ["crypto", "buffer", "stream", "util", "process", "events"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  optimizeDeps: { exclude: ["@zama-fhe/relayer-sdk"] },
  build: { target: "es2022", chunkSizeWarningLimit: 12000 },
  server: {
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" },
  },
});
