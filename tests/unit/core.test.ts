// SPDX-License-Identifier: Apache-2.0

// What is particular to JavaScript: numbers that are not all integers, text
// that is not bytes, and an entry point that must run without Node.js.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { decode, encode } from "../../src/bridge.js";
import {
  AgentIdentity,
  canonicalize,
  Digest,
  MalformedInputError,
  nativeAvailable,
  ready,
  TrustRegistry,
  Verifier,
  WorkPackage,
  WorkRecord,
} from "../../src/index.js";
import { epochSeconds, instant } from "../../src/time.js";
import { derivedId } from "../../src/uuid.js";
import { Parties, ROOT } from "../helpers.js";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("writing JSON for the verifier", () => {
  test("fractions are refused, never rounded", () => {
    for (const value of [0.5, 12.5, -0.1, 1e-7, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => encode({ amount: value }), String(value)).toThrow(TypeError);
    }
    expect(() => encode({ amount: 12.5 })).toThrow(/no fractional numbers/);
    expect(() => encode({ outer: [{ amount: 0.5 }] }, "body")).toThrow(/body\.outer\[0\]\.amount/);
  });

  test("an integer too large to be exact is refused, and a bigint is not", () => {
    expect(() => encode(2 ** 53)).toThrow(/use a bigint/);
    expect(() => encode(-(2 ** 53))).toThrow(TypeError);
    expect(() => encode(1e21)).toThrow(TypeError);
    expect(text(encode(Number.MAX_SAFE_INTEGER))).toBe("9007199254740991");
    expect(text(encode(Number.MIN_SAFE_INTEGER))).toBe("-9007199254740991");
    expect(text(encode({ n: 12345678901234567890n, m: -(2n ** 70n) }))).toBe(
      '{"n":12345678901234567890,"m":-1180591620717411303424}',
    );
    expect(text(encode(-0))).toBe("0");
    expect(text(encode(1.0))).toBe("1");
  });

  test("undefined is refused, not dropped", () => {
    expect(() => encode({ a: undefined })).toThrow(TypeError);
    expect(() => encode([1, undefined])).toThrow(/\[1\]/);
    expect(() => encode(undefined)).toThrow(TypeError);
  });

  test("anything that is not plain data is refused", () => {
    class Invoice {
      id = "INV-1";
    }
    const refused: unknown[] = [
      new Invoice(),
      new Date(0),
      new Map([["a", 1]]),
      new Set([1]),
      new Uint8Array(2),
      () => 1,
      Symbol("s"),
      Digest.ofBytes(new Uint8Array()),
    ];
    for (const value of refused) {
      expect(() => encode({ value }), String(value)).toThrow(TypeError);
    }
    expect(() => encode({ value: new Invoice() })).toThrow(/Invoice is not a JSON value/);
    // An object without a prototype is plain data.
    const bare = Object.assign(Object.create(null), { a: 1 });
    expect(text(encode(bare))).toBe('{"a":1}');
  });

  test("text is written as JSON escapes it", () => {
    const value = { 'k"ey': 'line\nbreak "quoted" \\ \u0000 é 😀' };
    expect(JSON.parse(text(encode(value)))).toEqual(value);
    expect(text(encode(null))).toBe("null");
    expect(text(encode([true, false, "", [], {}]))).toBe('[true,false,"",[],{}]');
  });
});

describe("reading the verifier's JSON", () => {
  test("an integer beyond 2^53 is read as a bigint, never rounded", () => {
    const read = decode(
      '{"small":7,"edge":9007199254740991,"big":9007199254740993,"neg":-12345678901234567890}',
    ) as Record<string, unknown>;
    expect(read["small"]).toBe(7);
    expect(read["edge"]).toBe(9007199254740991);
    expect(read["big"]).toBe(9007199254740993n);
    expect(read["neg"]).toBe(-12345678901234567890n);
    // What plain JSON.parse would have made of it.
    expect(JSON.parse("9007199254740993")).toBe(9007199254740992);
  });

  test("a large integer survives the round trip through the canonical encoder", () => {
    const value = { serial: 18446744073709551615n, nested: [2n ** 64n, 1] };
    const canonical = text(canonicalize(value));
    expect(canonical).toBe('{"nested":[18446744073709551616,1],"serial":18446744073709551615}');
    expect(decode(canonical)).toEqual(value);
    expect(Digest.ofJson(value).equals(Digest.ofJson(bytes(canonical)))).toBe(true);
    // A work record holding one keeps it exactly.
    const record = WorkRecord.fromJson(canonical);
    expect(record.members["serial"]).toBe(18446744073709551615n);
    expect(text(record.toBytes())).toBe(canonical);
  });

  test("a fraction in output is an error, not a number", () => {
    expect(() => decode('{"a":0.5}')).toThrow(MalformedInputError);
    expect(() => decode("1e400")).toThrow(MalformedInputError);
  });
});

describe("canonical values", () => {
  test("a string is a JSON string value; bytes are JSON text", () => {
    expect(text(canonicalize("a"))).toBe('"a"');
    expect(text(canonicalize('{"b":1,"a":2}'))).toBe('"{\\"b\\":1,\\"a\\":2}"');
    expect(text(canonicalize(bytes('{"b":1,"a":2}')))).toBe('{"a":2,"b":1}');
    expect(text(canonicalize(bytes(" [ 1 , 2 ] ")))).toBe("[1,2]");
    expect(() => canonicalize(bytes('{"a":1,"a":2}'))).toThrow(MalformedInputError);
    expect(() => canonicalize(Uint8Array.of(0xff, 0xfe))).toThrow(MalformedInputError);
  });
});

describe("digests", () => {
  const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

  test("of exact bytes, with no canonicalization", () => {
    expect(Digest.ofBytes(new Uint8Array()).hex).toBe(EMPTY);
    expect(Digest.ofBytes(bytes("abc")).hex).toBe(ABC);
    expect(Digest.ofBytes(bytes('{"b":1,"a":2}')).equals(Digest.ofJson({ b: 1, a: 2 }))).toBe(
      false,
    );
    expect(Digest.ofBytes(bytes('{"a":2,"b":1}')).equals(Digest.ofJson({ b: 1, a: 2 }))).toBe(true);
  });

  test("validation", () => {
    const refused = [
      "",
      "abc",
      ABC.toUpperCase(),
      ABC.slice(1),
      `${ABC}0`,
      `g${ABC.slice(1)}`,
      ` ${ABC.slice(1)}`,
      `${ABC.slice(0, 63)}\n`,
    ];
    for (const hex of refused) {
      expect(() => new Digest(hex), JSON.stringify(hex)).toThrow(RangeError);
    }
    expect(() => new Digest(ABC, "sha-512")).toThrow(/unsupported digest algorithm/);
    expect(() => Digest.fromWire({ algorithm: "md5", hex: ABC })).toThrow(RangeError);
    expect(() => Digest.parse(`sha-512:${ABC}`)).toThrow(RangeError);
  });

  test("the compact and the wire form", () => {
    const digest = new Digest(ABC);
    expect(digest.toString()).toBe(`sha-256:${ABC}`);
    expect(`${digest}`).toBe(`sha-256:${ABC}`);
    expect(digest.toWire()).toEqual({ algorithm: "sha-256", hex: ABC });
    expect(JSON.stringify({ digest })).toBe(`{"digest":{"algorithm":"sha-256","hex":"${ABC}"}}`);
    expect(Digest.parse(`sha-256:${ABC}`).equals(digest)).toBe(true);
    expect(Digest.parse(ABC).equals(digest)).toBe(true);
    expect(Digest.fromWire(digest.toWire()).equals(digest)).toBe(true);
    expect(digest.equals(new Digest(EMPTY))).toBe(false);
    expect(Object.isFrozen(digest)).toBe(true);
  });
});

describe("derived identifiers", () => {
  // Computed with verified-python 0.1.0: AgentIdentity(name, version=version).id
  const fromPython: [string, string, string][] = [
    ["invoice-agent", "1", "1869caba-8bec-58bd-9ce4-f14e96e3caf1"],
    ["invoice-agent", "", "40a2c16b-b235-5bbd-bd6a-abd27b2f38f6"],
    ["Zoë-agent", "2", "70e43555-7e88-5099-9abc-a035628c27d0"],
    ["agent-😀", "x", "fd46b025-1edc-5732-819c-fe5fd9ec7824"],
  ];

  test.each(fromPython)(
    "%j version %j is the identifier the Python SDK derives",
    (name, version, id) => {
      expect(new AgentIdentity(name, { version }).id).toBe(id);
    },
  );

  test("an agent with no version is the agent with an empty one", () => {
    expect(new AgentIdentity("invoice-agent").id).toBe("40a2c16b-b235-5bbd-bd6a-abd27b2f38f6");
  });

  test("parts are length-prefixed, as in the Python SDK", () => {
    // verified.work.derived_id("ab", "c") and derived_id("a", "bc")
    expect(derivedId("ab", "c")).toBe("b328736c-a4a1-55ff-b26d-748085bc9bc3");
    expect(derivedId("a", "bc")).toBe("d54cf119-00c3-5e65-93da-b9a52ef443cc");
  });

  test("a derived identifier is a version 5 UUID", () => {
    for (const name of [
      "",
      "a",
      "x".repeat(55),
      "x".repeat(56),
      "x".repeat(64),
      "x".repeat(1000),
    ]) {
      expect(derivedId(name), `${name.length} characters`).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(new Set(["", "a", "x".repeat(55), "x".repeat(56)].map((n) => derivedId(n))).size).toBe(
      4,
    );
  });
});

describe("instants", () => {
  test("whole seconds have no fraction; milliseconds have three digits", () => {
    expect(instant(new Date(Date.UTC(2026, 2, 1, 10, 0, 0)))).toBe("2026-03-01T10:00:00Z");
    expect(instant(new Date(Date.UTC(2026, 2, 1, 10, 0, 0, 7)))).toBe("2026-03-01T10:00:00.007Z");
    expect(instant(new Date(Date.UTC(2026, 2, 1, 10, 0, 0, 250)))).toBe("2026-03-01T10:00:00.250Z");
    expect(instant(new Date("2026-03-01T12:00:00+02:00"))).toBe("2026-03-01T10:00:00Z");
    expect(instant(new Date(0))).toBe("1970-01-01T00:00:00Z");
  });

  test("text is passed through for the verifier to judge", () => {
    expect(instant("2026-03-01T10:00:00.123456Z")).toBe("2026-03-01T10:00:00.123456Z");
    expect(instant("not an instant")).toBe("not an instant");
  });

  test("an invalid Date names no instant", () => {
    expect(() => instant(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => epochSeconds(new Date("nonsense"))).toThrow(RangeError);
  });

  test("epoch seconds round down, before 1970 too", () => {
    expect(epochSeconds(new Date(1999))).toBe(1);
    expect(epochSeconds(new Date(-1))).toBe(-1);
    expect(epochSeconds(new Date(Date.UTC(2026, 2, 1, 10, 0, 0, 999)))).toBe(1772359200);
  });

  test("an instant this SDK writes is one the verifier reads", () => {
    const parties = new Parties();
    const at = new Date(Date.UTC(2026, 2, 1, 10, 0, 0, 250));
    const record = parties.gateway.record(
      "posting",
      { document: "D" },
      { subject: parties.subject(), observedAt: at },
    );
    expect(record.observedAt).toBe("2026-03-01T10:00:00.250Z");
    expect(record.authenticate(parties.trust).authenticated).toBe(true);
  });
});

describe("a verifier's trust", () => {
  test("has no default, in plain JavaScript either", () => {
    const construct = Verifier as unknown as new (...args: unknown[]) => Verifier;
    expect(() => new construct({})).toThrow(TypeError);
    expect(() => new construct({})).toThrow(/trust has no default/);
    expect(() => new construct()).toThrow(TypeError);
    expect(() => new construct(null)).toThrow(TypeError);
    expect(() => new construct({ expect: { tenant: "t" } })).toThrow(TypeError);
    expect(() => new construct({ trust: "trust.json" })).toThrow(/TrustRegistry/);
    expect(() => new construct({ trust: { keys: [] } })).toThrow(/TrustRegistry/);
    expect(new construct({ trust: null }).trust).toBeNull();
  });

  test("a registry cannot be changed through what it hands out", () => {
    const parties = new Parties();
    const before = parties.trust.byteDigest;
    parties.trust.toBytes().fill(0);
    (parties.trust.toObject()["keys"] as unknown[]).length = 0;
    expect(parties.trust.byteDigest.equals(before)).toBe(true);
    expect(parties.trust.size).toBe(3);
    expect(parties.trust.find("erp-gateway-1")?.sources).toEqual(["erp"]);
    expect(parties.trust.find("nobody")).toBeUndefined();
    expect(Object.isFrozen(parties.trust.keys)).toBe(true);
    expect(TrustRegistry.fromJson(parties.trust.toBytes()).byteDigest.equals(before)).toBe(true);
  });

  test("a package cannot be changed through what it hands out", () => {
    const original = bytes('{"packageId":"wvp:sha-256:00"}');
    const held = new WorkPackage(original);
    original.fill(0);
    held.text.fill(0);
    expect(held.statedPackageId).toBe("wvp:sha-256:00");
    expect(new WorkPackage("not json").statedPackageId).toBeUndefined();
    expect(new WorkPackage('{"packageId":7}').statedPackageId).toBeUndefined();
  });
});

describe("loading the module", () => {
  test("ready() resolves, and again", async () => {
    await expect(ready()).resolves.toBeUndefined();
    await expect(ready()).resolves.toBeUndefined();
    await expect(Promise.all([ready(), ready()])).resolves.toEqual([undefined, undefined]);
    expect(nativeAvailable()).toBe(true);
    expect(Digest.ofBytes(new Uint8Array()).hex).toMatch(/^e3b0c442/);
  });
});

describe("the core entry point", () => {
  /** Every source file reachable from `entry` by static or dynamic import. */
  function reachable(entry: string): Map<string, string[]> {
    const seen = new Map<string, string[]>();
    const visit = (file: string): void => {
      if (seen.has(file)) {
        return;
      }
      // Generated JavaScript has no TypeScript source beside it.
      const source = existsSync(file) ? file : file.replace(/\.ts$/, ".js");
      if (!existsSync(source)) {
        throw new Error(`${file} is imported and does not exist (run \`npm run build:native\`)`);
      }
      const code = readFileSync(source, "utf8");
      const specifiers = [
        ...code.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gms),
        ...code.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
        ...code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
        ...code.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
      ].map((match) => match[1] as string);
      seen.set(file, specifiers);
      for (const specifier of specifiers) {
        if (specifier.startsWith(".")) {
          visit(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
        }
      }
    };
    visit(entry);
    return seen;
  }

  const outside = (graph: Map<string, string[]>): string[] =>
    [
      ...new Set([...graph.values()].flat().filter((specifier) => !specifier.startsWith("."))),
    ].sort();

  test("imports nothing but its own files", () => {
    const graph = reachable(join(ROOT, "src", "index.ts"));
    // The whole core is in the graph, generated glue included.
    const files = [...graph.keys()].map((file) => file.slice(join(ROOT, "src").length + 1));
    expect(files).toEqual(
      expect.arrayContaining([
        "index.ts",
        "bridge.ts",
        "verification.ts",
        "work.ts",
        "native/glue.ts",
      ]),
    );
    // No Node.js built-in and no dependency: it runs wherever WebAssembly does.
    expect(outside(graph)).toEqual([]);
    expect(files.some((file) => file.startsWith("instrumentation") || file === "node.ts")).toBe(
      false,
    );
  });

  test("the other entry points are where the Node.js built-ins are", () => {
    expect(outside(reachable(join(ROOT, "src", "node.ts")))).toEqual(["node:fs"]);
    expect(outside(reachable(join(ROOT, "src", "instrumentation", "index.ts")))).toEqual([
      "node:async_hooks",
    ]);
  });

  test("uses no global that only Node.js has", () => {
    const graph = reachable(join(ROOT, "src", "index.ts"));
    for (const file of graph.keys()) {
      if (file.includes(`${join("src", "native")}`)) {
        continue;
      }
      const code = readFileSync(file, "utf8");
      expect(code, file).not.toMatch(/\b(Buffer|process)\s*[.[(]|\b__dirname\b|\b__filename\b/);
    }
  });

  test("the package has no runtime dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.peerDependencies ?? {}).toEqual({});
  });
});
