// SPDX-License-Identifier: Apache-2.0

// Copies the generated native module beside the compiled TypeScript.

import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, "src", "native");
if (!existsSync(join(from, "wasm.js"))) {
  throw new Error("src/native is missing: run `npm run build:native` first");
}
cpSync(from, join(root, "dist", "native"), { recursive: true });
