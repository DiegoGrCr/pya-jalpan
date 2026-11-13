import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 240_000,
    // Las pruebas de BD comparten un Postgres embebido: se ejecutan en serie
    fileParallelism: false,
    pool: "forks",
  },
});
