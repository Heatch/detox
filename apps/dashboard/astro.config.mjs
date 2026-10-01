import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import { daemon } from "./src/integration/daemon.ts";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [daemon()],
  // Localhost-only daemon, no cookies or auth: same-origin CSRF checks would
  // also block legitimate non-browser clients, so they stay off.
  security: { checkOrigin: false },
  vite: {
    // better-sqlite3 is CJS with __filename references — it must load at
    // runtime via require(), never bundled into the ESM server chunk.
    ssr: { external: ["better-sqlite3"] },
  },
});
