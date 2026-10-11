# 0010. No schema library and no runtime dependencies

Status: accepted.

## Decision

`package.json` declares no `dependencies`. Domain types are classes with
`readonly` fields, interfaces, and `as const` objects for closed vocabularies.
There is no schema library. Base64, UTF-8, UUIDs and random bytes come from
what every runtime provides (`atob`, `TextEncoder`, `crypto`).

## Why

- Wire validation is done once, exactly, by the Rust side: unknown members,
  canonical spellings, integer ranges. A Zod schema would be a second, looser
  definition of the same formats.
- The protocol has no floats and uses text for numbers; general-purpose
  coercion is the opposite of what is wanted.
- An SDK meant to sit inside other people's agents should not pin their
  schema, HTTP or tracing stack, and should not widen their supply chain.
  What a user installs is this package and nothing else.

## Cost

A small amount of code that a dependency would have supplied, including a
SHA-1 used only to derive name-based UUIDs (labels, not protocol values).

## Would change if

A platform client or a framework adapter is added. Its dependency would be a
peer dependency of its own entry point, never of the core.
