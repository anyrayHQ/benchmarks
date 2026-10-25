// A public repo must not name a customer. The denylist is stored as SHA-256 of the lowercased
// identifier, so this file does not publish what it guards. Matching is by whole token (and by
// two adjacent tokens joined with or without a hyphen), never by substring: a plain
// `grep -ri salt` also fails on SaltStack paths, which are legitimate.
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s).digest('hex');

export const CUSTOMER_IDENTIFIER_HASHES = new Set([
  'e9f01b10fb62e20c4b31012c5a2eaafe0280fedae54d01d9f3a2643c2c3ed1f4',
  '15e6ffcbfaf662f5d7ed32c57e8617f8a9f49736331ebca741e0dc940ee13d3b',
  'd9c42b950675899b4c3d024eda0ad7cd7bb4b1dec798f3e22addd3724fca64ab',
  'a937964cf2624763ff9653b1746eac07bb6835569e0f986f17ee047b2dc4e784',
]);

/** The customer identifiers `text` names, as the hashes that matched (never the words). */
export function customerIdentifierHits(text, hashes = CUSTOMER_IDENTIFIER_HASHES) {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const hits = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const candidates = [tokens[i]];
    if (i + 1 < tokens.length) candidates.push(`${tokens[i]}-${tokens[i + 1]}`, `${tokens[i]}${tokens[i + 1]}`);
    for (const c of candidates) if (hashes.has(sha(c))) hits.add(sha(c));
  }
  return [...hits];
}
