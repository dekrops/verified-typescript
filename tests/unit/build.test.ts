// SPDX-License-Identifier: Apache-2.0

// The build says what it is made of, and the pins agree with each other.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

import { buildInfo, VERSION } from "../../src/index.js";
import { ROOT } from "../helpers.js";

const CORPUS_PIN = "c7c9de2a7e8ad67e7dcee46d5c5f7fc2edccb797";
const cargo = readFileSync(join(ROOT, "rust", "Cargo.toml"), "utf8");

test("one upstream revision is pinned everywhere", () => {
  const dependencies = [...cargo.matchAll(/^(verified-[a-z-]+) = \{([^}]*)\}$/gm)];
  expect(dependencies.map((match) => match[1]).sort()).toEqual([
    "verified-canonical",
    "verified-contract",
    "verified-protocol",
    "verified-verifier",
    "verified-work-unit",
  ]);
  const revisions = new Set(
    dependencies.map((match) => /rev = "([^"]*)"/.exec(match[2] as string)?.[1]),
  );
  const sources = new Set(
    dependencies.map((match) => /git = "([^"]*)"/.exec(match[2] as string)?.[1]),
  );
  const info = buildInfo();
  expect([...revisions]).toEqual([info["upstreamRevision"]]);
  expect([...sources]).toEqual([info["upstream"]]);
  expect(info["upstreamRevision"]).toMatch(/^[0-9a-f]{40}$/);
  expect(info["verifier"]).toBe(`verified-verifier-${info["upstreamRevision"]}`);
  expect(info["protocols"]).toEqual(["wvp-0.1", "wvp-0.2"]);
  const compatibility = readFileSync(join(ROOT, "docs", "protocol-compatibility.md"), "utf8");
  expect(compatibility).toContain(String(info["upstreamRevision"]));
  expect(info["canonicalVersion"]).toBe("verified-json-v1");

  // The lockfile builds what the manifest names, and nothing else from upstream.
  const lock = readFileSync(join(ROOT, "rust", "Cargo.lock"), "utf8");
  const locked = new Set(
    [...lock.matchAll(/verified-cli\?rev=([0-9a-f]+)#([0-9a-f]+)/g)].flatMap((match) => [
      match[1],
      match[2],
    ]),
  );
  expect([...locked]).toEqual([info["upstreamRevision"]]);
});

test("versions agree", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const crate = /^\[package\][^[]*?^version = "([^"]*)"$/ms.exec(cargo)?.[1];
  expect(crate).toBeDefined();
  expect(manifest.version).toBe(VERSION);
  expect(crate).toBe(VERSION);
  expect(buildInfo()["version"]).toBe(VERSION);
});

test("the module post-processor is pinned to the crate it serves", () => {
  // scripts/build-native.mjs refuses to build unless this is an exact pin.
  expect(cargo).toMatch(/^wasm-bindgen = "=\d+\.\d+\.\d+"$/m);
});

test.skipIf(!existsSync(join(ROOT, ".git")))("the corpus pin is the documented one", () => {
  const done = spawnSync("git", ["-C", ROOT, "ls-files", "-s", "conformance/wvp"], {
    encoding: "utf8",
  });
  expect(done.status).toBe(0);
  // "160000 <commit> 0\tconformance/wvp": a submodule entry at the pinned commit.
  const [mode, commit] = done.stdout.trim().split(/\s+/);
  expect(mode).toBe("160000");
  expect(commit).toBe(CORPUS_PIN);
});
