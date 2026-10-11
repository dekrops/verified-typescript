// SPDX-License-Identifier: Apache-2.0

// Every example and every README code block runs, offline, and the
// checked-in fixtures are current. These run the built package, as a user
// would: `npm test` builds it first.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

import { build } from "../../examples/standalone-verification/make-fixtures.js";
import { Digest } from "../../src/index.js";
import { ROOT } from "../helpers.js";

const EXAMPLES = join(ROOT, "examples");
const SCRIPTS = [
  "standalone-verification/verify-packages.ts",
  "invoice-posting/invoice-agent.ts",
  "chatbot-compliance/support-chatbot.ts",
  "enterprise-evidence/order-gateway.ts",
];

const run = (path: string): string =>
  execFileSync(process.execPath, [path], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });

describe("the examples", () => {
  beforeAll(() => {
    expect(
      existsSync(join(ROOT, "dist", "index.js")),
      "the package is not built: run `npm run build`",
    ).toBe(true);
  });

  test.each(SCRIPTS)("%s runs", (script) => {
    expect(run(join(EXAMPLES, script)).trim()).not.toBe("");
  });

  test("the invoice example shows all three decisions", () => {
    const out = run(join(EXAMPLES, "invoice-posting", "invoice-agent.ts"));
    for (const expected of ["SUPPORTED", "UNDETERMINED", "CONTRADICTED", "SOURCE_NOT_AUTHORIZED"]) {
      expect(out).toContain(expected);
    }
    expect(out.split("agent reports          accepted")).toHaveLength(4);
  });

  test("the checked-in fixtures are what the generator produces", () => {
    for (const [name, content] of Object.entries(build())) {
      const held = readFileSync(join(EXAMPLES, "standalone-verification", name));
      expect(Buffer.from(content).equals(held), `${name} is stale`).toBe(true);
    }
  });

  // The Python SDK issues the same three packages from the same inputs
  // (dekrops/verified-python, examples/standalone-verification). Two bindings
  // of one library must agree to the byte.
  test.each([
    ["supported.json", "fb3e52797e7b1c07c5f7a333cf2f596d73596d69f85ea8fd9c5a962462c6bc47"],
    ["contradicted.json", "4eea81394348665091401b97e36aa89c510d3f0039c3158c65ab0a7b1baca0e1"],
    ["undetermined.json", "7b92ca27c93fd6e2e15d1a5f0670c687907c1eb2b55dc4975107cae6db5ea707"],
  ])("%s is byte for byte the Python SDK's", (name, sha256) => {
    const held = readFileSync(join(EXAMPLES, "standalone-verification", name));
    expect(Digest.ofBytes(held).hex).toBe(sha256);
  });

  test("the README's examples run as written", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const blocks = [...readme.matchAll(/```ts\n(.*?)```/gs)].map((match) => match[1] as string);
    expect(blocks).toHaveLength(4);
    const scratch = join(ROOT, ".readme-check");
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch);
    try {
      blocks.forEach((block, index) => {
        const path = join(scratch, `block-${index + 1}.ts`);
        writeFileSync(path, block);
        expect(run(path).trim(), `README block ${index + 1}`).not.toBe("");
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
