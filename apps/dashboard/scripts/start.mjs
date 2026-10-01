// Production entry: fixes DETOX_ROOT + PORT/HOST, then boots the standalone server.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..", "..");
process.env.DETOX_ROOT ??= ROOT;
process.env.PORT ??= "4321";
process.env.HOST ??= "127.0.0.1";

await import("../dist/server/entry.mjs");
