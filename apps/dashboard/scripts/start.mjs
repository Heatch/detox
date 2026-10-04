// Production entry: fixes DETOX_ROOT + PORT/HOST, arms the daemon (initial
// pipeline + 09:00 scheduler), then boots the standalone server.
//
// The daemon lives in an Astro integration, but Astro does not run integration
// hooks in a built standalone server — only `astro dev` fires
// astro:server:setup. So production has to arm it here instead. The `tsx`
// loader is what lets this plain ESM entry import the TypeScript workspace
// packages; see the `start` script in package.json.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..", "..");
process.env.DETOX_ROOT ??= ROOT;
process.env.PORT ??= "4321";
process.env.HOST ??= "127.0.0.1";

const { armDaemon } = await import("../src/integration/daemon.ts");
armDaemon(ROOT);

await import("../dist/server/entry.mjs");
