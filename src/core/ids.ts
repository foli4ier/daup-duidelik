// duidelik — ULID id generation (DATA-MODEL.md §6-A, locked Q3)
//
// All `id` fields across the registry graph are ULIDs: sortable, collision-free,
// and client-generatable with no server. `DataProduct.code` ("DAPP-6036") is a
// separate human-facing label, NOT an id.
//
// Dependency-free, spec-compliant ULID (Crockford base32, 48-bit time + 80-bit
// randomness). Isolated so the migration to a server/DB (STACK §5) that may mint ids
// differently is a one-file swap. Ported verbatim from app/src/ids.js.

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (no I,L,O,U)
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

export type Rng = () => number;

// Pluggable randomness so tests can seed it deterministically.
function defaultRandom(): number {
  const g = (typeof globalThis !== "undefined" && globalThis.crypto) || null;
  if (g && typeof g.getRandomValues === "function") {
    const buf = new Uint8Array(1);
    g.getRandomValues(buf);
    return buf[0] / 0xff;
  }
  return Math.random();
}

function encodeTime(now: number, len: number): string {
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % ENCODING_LEN;
    out = ENCODING[mod] + out;
    now = (now - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(len: number, rng: Rng): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ENCODING[Math.floor(rng() * ENCODING_LEN)];
  }
  return out;
}

/** Generate a ULID. seedTime / rng are exposed for deterministic tests. */
export function ulid(seedTime?: number, rng: Rng = defaultRandom): string {
  const now = seedTime == null ? Date.now() : seedTime;
  return encodeTime(now, TIME_LEN) + encodeRandom(RANDOM_LEN, rng);
}

/** True if `s` looks like a ULID (26 Crockford-base32 chars). */
export function isUlid(s: unknown): boolean {
  return (
    typeof s === "string" &&
    s.length === TIME_LEN + RANDOM_LEN &&
    [...s].every((c) => ENCODING.includes(c))
  );
}
