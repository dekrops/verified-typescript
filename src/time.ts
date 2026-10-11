// SPDX-License-Identifier: Apache-2.0

// Instants in the protocol's spelling.

/** A source of the current time. Pass a fixed one to make runs reproducible. */
export type Clock = () => Date;

/** The default clock: the current time. */
export function now(): Date {
  return new Date();
}

/**
 * `YYYY-MM-DDTHH:MM:SSZ`, with a fraction of 3 digits when needed.
 *
 * A string is passed through untouched: the verifier decides whether it is
 * an instant.
 */
export function instant(at: Date | string): string {
  if (typeof at === "string") {
    return at;
  }
  if (Number.isNaN(at.getTime())) {
    throw new RangeError("an invalid Date names no instant");
  }
  const iso = at.toISOString();
  return iso.endsWith(".000Z") ? `${iso.slice(0, -5)}Z` : iso;
}

/** Whole seconds since 1970-01-01T00:00:00Z, rounded down. */
export function epochSeconds(at: Date): number {
  if (Number.isNaN(at.getTime())) {
    throw new RangeError("an invalid Date names no instant");
  }
  return Math.floor(at.getTime() / 1000);
}
