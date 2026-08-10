/**
 * A small 7-segment ASCII-art digit font, used to make a recipe step's number
 * hard to miss at a glance while cooking — the number matters far more than the
 * step text does when your hands are busy and you just need "which step am I on".
 *
 * Deliberately plain box-drawing characters (▔ ▁ ─ │), not solid blocks: it
 * should read as a bigger number, not a loud banner.
 */

interface Segments {
  a: boolean; // top
  b: boolean; // top-right
  c: boolean; // bottom-right
  d: boolean; // bottom
  e: boolean; // bottom-left
  f: boolean; // top-left
  g: boolean; // middle
}

const SEGMENTS: Record<string, Segments> = {
  "0": { a: true, b: true, c: true, d: true, e: true, f: true, g: false },
  "1": { a: false, b: true, c: true, d: false, e: false, f: false, g: false },
  "2": { a: true, b: true, c: false, d: true, e: true, f: false, g: true },
  "3": { a: true, b: true, c: true, d: true, e: false, f: false, g: true },
  "4": { a: false, b: true, c: true, d: false, e: false, f: true, g: true },
  "5": { a: true, b: false, c: true, d: true, e: false, f: true, g: true },
  "6": { a: true, b: false, c: true, d: true, e: true, f: true, g: true },
  "7": { a: true, b: true, c: true, d: false, e: false, f: false, g: false },
  "8": { a: true, b: true, c: true, d: true, e: true, f: true, g: true },
  "9": { a: true, b: true, c: true, d: true, e: false, f: true, g: true },
};

/** Rows per glyph, including a blank digit (used to pad shorter numbers). */
export const DIGIT_HEIGHT = 5;
/** Columns per glyph. */
export const DIGIT_WIDTH = 3;

const BLANK_GLYPH = Array.from({ length: DIGIT_HEIGHT }, () => " ".repeat(DIGIT_WIDTH));

function digitGlyph(ch: string): string[] {
  if (ch === " ") return BLANK_GLYPH;
  const s = SEGMENTS[ch];
  if (!s) return BLANK_GLYPH; // non-digit input — render as blank rather than throw
  return [
    s.a ? "▔▔▔" : "   ",
    (s.f ? "│" : " ") + " " + (s.b ? "│" : " "),
    s.g ? "───" : "   ",
    (s.e ? "│" : " ") + " " + (s.c ? "│" : " "),
    s.d ? "▁▁▁" : "   ",
  ];
}

/**
 * Render `num` as a multi-line glyph, `minDigits` wide (shorter numbers are
 * padded with an invisible leading digit so a recipe's step numbers don't
 * jitter in width between step 9 and step 10).
 */
export function renderStepNumber(num: number, minDigits = 1): string[] {
  const digits = String(num).padStart(minDigits, " ").split("");
  const glyphs = digits.map(digitGlyph);
  return Array.from(
    { length: DIGIT_HEIGHT },
    (_, row) => glyphs.map((g) => g[row]).join(" "),
  );
}

/** Total width of a rendered number, for layout math. */
export function stepNumberWidth(minDigits: number): number {
  return minDigits * DIGIT_WIDTH + (minDigits - 1);
}
