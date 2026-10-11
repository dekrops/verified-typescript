import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Example code imports the package by name; in tests that is the source.
    alias: [
      {
        find: /^verified-typescript\/instrumentation$/,
        replacement: source("./src/instrumentation/index.ts"),
      },
      { find: /^verified-typescript\/node$/, replacement: source("./src/node.ts") },
      { find: /^verified-typescript$/, replacement: source("./src/index.ts") },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
