import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import tsconfigPaths from "vite-tsconfig-paths";
import manifest from "./src/manifest";

export default defineConfig({
  plugins: [tsconfigPaths(), react(), crx({ manifest })],
  build: { sourcemap: true }
});
