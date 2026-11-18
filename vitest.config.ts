import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "cloudflare:sockets": fileURLToPath(new URL("./test/stubs/cloudflare-sockets.ts", import.meta.url)) } },
});
