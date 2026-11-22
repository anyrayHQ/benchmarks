// A small seeded generator, so a simulation or a calibration split repeats exactly.

/** mulberry32: uniform [0, 1) from a 32-bit seed. */
export function seededUniform(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` standard normals (Box-Muller) from `next`. */
export function normals(next, count) {
  const out = [];
  while (out.length < count) {
    const r = Math.sqrt(-2 * Math.log(1 - next()));
    const th = 2 * Math.PI * next();
    out.push(r * Math.cos(th));
    if (out.length < count) out.push(r * Math.sin(th));
  }
  return out;
}

/** A copy of `xs` in a seeded random order (Fisher-Yates). */
export function shuffled(xs, next) {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
