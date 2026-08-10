/**
 * Ingredient line parsing.
 *
 * Recipe sources give ingredients as free text ("2.5 pounds ground chuck",
 * "1 (14.5 ounce) can diced tomatoes, drained"). To later answer "what can I make
 * with anchovies and olives?" we need the *name* separated from the *amount*, plus a
 * normalised name to match against a pantry list.
 *
 * Each line yields:
 *   quantity / quantityMax  numeric amount, or a range ("2 to 3" -> 2, 3)
 *   unit                    canonical singular unit ("tablespoon", "clove"), or null
 *   packSize / packUnit     the "(14.5 ounce)" in "1 (14.5 ounce) can"
 *   name                    descriptive name as written, minus size words
 *   nameNorm                aggressively normalised key for pantry matching
 *   note                    prep/qualifier tail ("coarsely chopped", "or to taste")
 *   optional                line is marked optional
 *
 * `nameNorm` is deliberately lossy: "3 cloves garlic, minced" and "1 head garlic"
 * both normalise to "garlic" so a pantry query matches either.
 */

export interface ParsedIngredient {
  raw: string;
  quantity: number | null;
  quantityMax: number | null;
  unit: string | null;
  packSize: number | null;
  packUnit: string | null;
  name: string;
  nameNorm: string;
  note: string | null;
  optional: boolean;
  /** Section label ("Relish", "For the sauce:") rather than a real ingredient. */
  isHeading: boolean;
}

const VULGAR: Record<string, number> = {
  "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75,
  "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8, "⅙": 1 / 6, "⅚": 5 / 6,
  "⅐": 1 / 7, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875, "⅑": 1 / 9, "⅒": 0.1,
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  dozen: 12, half: 0.5, quarter: 0.25,
};

/** alias -> canonical singular unit */
const UNITS: Record<string, string> = {};
function unit(canonical: string, ...aliases: string[]) {
  UNITS[canonical] = canonical;
  UNITS[canonical + "s"] = canonical;
  for (const a of aliases) UNITS[a] = canonical;
}

// volume
unit("teaspoon", "tsp", "tsps", "tsp.", "t.");
unit("tablespoon", "tbsp", "tbsps", "tbsp.", "tbs", "tblsp", "T.");
unit("cup", "c.");
unit("fluid ounce", "fl oz", "fl. oz.", "fl oz.", "fluid ounces", "floz");
unit("pint", "pt", "pt.");
unit("quart", "qt", "qt.");
unit("gallon", "gal", "gal.");
unit("milliliter", "ml", "ml.", "millilitre", "millilitres", "milliliters");
unit("liter", "l.", "litre", "litres", "liters");
unit("drop");
unit("dash", "dashes");
unit("pinch", "pinches");
unit("splash", "splashes");
// weight
unit("ounce", "oz", "oz.");
unit("pound", "lb", "lbs", "lb.", "lbs.");
unit("gram", "g", "g.", "gr", "grams");
unit("kilogram", "kg", "kg.", "kilo", "kilos");
// containers & countable forms
unit("clove");
unit("can");
unit("jar");
unit("package", "pkg", "pkg.", "pkgs");
unit("container");
unit("bunch", "bunches");
unit("head");
unit("stalk");
unit("rib");
unit("slice");
unit("sprig");
unit("stick");
unit("ear");
unit("sheet");
unit("fillet", "filet", "filets");
unit("piece");
unit("strip");
unit("leaf", "leaves");
unit("bulb");
unit("wedge");
unit("cube");
unit("loaf", "loaves");
unit("link");
unit("rack");
unit("bag");
unit("box", "boxes");
unit("bottle");
unit("envelope");
unit("packet");
unit("scoop");
unit("handful", "handfuls");
unit("recipe");

/** Size adjectives: dropped from `name`, they describe the unit not the ingredient. */
const SIZE_WORDS = new Set([
  "large", "medium", "small", "extra-large", "extra", "jumbo", "baby", "mini",
  "giant", "thick", "thin", "heaping", "scant", "generous", "level",
]);

/**
 * Prep/state words stripped only from `nameNorm`. `name` keeps them because
 * "ground chuck" and "smoked paprika" read wrong without them.
 */
const PREP_WORDS = new Set([
  "fresh", "freshly", "frozen", "dried", "dry", "canned", "cooked", "uncooked", "raw",
  "chopped", "minced", "diced", "sliced", "shredded", "grated", "crushed", "ground",
  "peeled", "seeded", "cored", "trimmed", "rinsed", "drained", "melted", "softened",
  "beaten", "whisked", "toasted", "roasted", "smoked", "cubed", "quartered", "halved",
  "julienned", "shaved", "torn", "packed", "sifted", "room",
  "temperature", "boiling", "lukewarm", "prepared", "plain", "whole", "finely",
  "coarsely", "coarse", "roughly", "thinly", "lightly", "well", "very", "optional", "divided",
  "plus", "more", "needed", "taste", "such", "as", "or", "and", "for", "to", "of",
  "into", "cut", "your", "favorite", "good", "quality", "best",
]);

/** Words that mark the start of a trailing note when they open a comma-clause. */
const NOTE_STARTERS = /^(or\b|plus\b|about\b|to taste|for \b|cut \b|at room|see \b|if \b|preferably\b|optional\b|divided\b|drained\b|rinsed\b|thawed\b|softened\b|melted\b|beaten\b|packed\b|peeled\b|seeded\b|halved\b|quartered\b|sliced\b|chopped\b|minced\b|diced\b|grated\b|crushed\b|trimmed\b|cored\b|stemmed\b|shredded\b|room temperature)/i;

const IRREGULAR_PLURALS: Record<string, string> = {
  leaves: "leaf", loaves: "loaf", halves: "half", knives: "knife", potatoes: "potato",
  tomatoes: "tomato", anchovies: "anchovy", berries: "berry", cherries: "cherry",
  chilies: "chili", chiles: "chile", scallions: "scallion",
};

/** Nouns that are conventionally plural — leave them alone. */
const KEEP_PLURAL = new Set(["greens", "grits", "oats", "capers", "peas", "beans"]);

function singularize(word: string): string {
  if (IRREGULAR_PLURALS[word]) return IRREGULAR_PLURALS[word];
  if (KEEP_PLURAL.has(word) || word.length <= 3) return word;
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (/(ch|sh|ss|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) {
    return word.slice(0, -1);
  }
  return word;
}

/** Expand vulgar fractions and normalise whitespace/dashes. */
function preclean(s: string): string {
  let out = s;
  // Must run before NFKC: normalising "½" yields "1⁄2", losing the glyph and
  // gluing it to any preceding digit ("1½" -> "11⁄2").
  for (const [glyph, val] of Object.entries(VULGAR)) {
    out = out.replaceAll(glyph, ` ${val} `);
  }
  out = out.normalize("NFKC").replace(/⁄/g, "/"); // fraction slash -> solidus
  return out.replace(/\s+/g, " ").trim();
}

/** Parse a leading amount, returning the value and how much of the string it ate. */
function parseAmount(tokens: string[]): { value: number | null; max: number | null; used: number } {
  let i = 0;
  let total: number | null = null;

  const readOne = (): number | null => {
    const tok = tokens[i];
    if (tok === undefined) return null;
    const frac = /^(\d+)\/(\d+)$/.exec(tok);
    if (frac) { i++; return Number(frac[1]) / Number(frac[2]); }
    if (/^\d+(\.\d+)?$/.test(tok)) { i++; return Number(tok); }
    const lower = tok.toLowerCase();
    if (lower in NUMBER_WORDS) { i++; return NUMBER_WORDS[lower]; }
    return null;
  };

  let first = readOne();
  if (first === null) return { value: null, max: null, used: 0 };

  // mixed number: "1 1/2" or "1 0.5" (from an expanded vulgar fraction)
  const next = tokens[i];
  if (next && (/^\d+\/\d+$/.test(next) || /^0\.\d+$/.test(next)) && Number.isInteger(first)) {
    const extra = readOne();
    if (extra !== null && extra < 1) first += extra;
  }
  total = first;

  // range: "2 to 3", "2-3"
  let max: number | null = null;
  const sep = tokens[i]?.toLowerCase();
  if (sep === "to" || sep === "-" || sep === "or") {
    const save = i;
    i++;
    const hi = readOne();
    if (hi !== null && hi > total) max = hi;
    else i = save;
  }
  return { value: total, max, used: i };
}

/** Match a unit at `tokens[i]`, allowing two-word units like "fluid ounce". */
function matchUnit(tokens: string[], i: number): { unit: string; used: number } | null {
  const two = `${tokens[i] ?? ""} ${tokens[i + 1] ?? ""}`.toLowerCase().replace(/[.,]$/, "");
  if (UNITS[two]) return { unit: UNITS[two], used: 2 };
  const one = (tokens[i] ?? "").toLowerCase().replace(/[.,]$/, "");
  if (UNITS[one]) return { unit: UNITS[one], used: 1 };
  return null;
}

/** Strip a trailing prep clause: "carrot, coarsely chopped" -> name + note. */
function splitNote(text: string): { head: string; note: string | null } {
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  if (parts.length === 1) return { head: parts[0].trim(), note: null };

  // The head is everything up to the first clause that reads like a note.
  for (let i = 1; i < parts.length; i++) {
    if (NOTE_STARTERS.test(parts[i].trim())) {
      return {
        head: parts.slice(0, i).join(",").trim(),
        note: parts.slice(i).join(",").trim() || null,
      };
    }
  }
  // No clause looked like prep ("salt and pepper, to taste" handled above);
  // treat the last comma clause as a note only if the head is still substantial.
  const head = parts.slice(0, -1).join(",").trim();
  const tail = parts[parts.length - 1].trim();
  if (head.length >= 3 && tail.split(" ").length <= 6) return { head, note: tail || null };
  return { head: text.trim(), note: null };
}

export function normalizeName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const kept = cleaned
    .split(" ")
    .filter((w) => w && !PREP_WORDS.has(w) && !SIZE_WORDS.has(w) && !UNITS[w])
    .map(singularize);
  // Everything was a modifier ("to taste") — fall back to the plain cleaned text.
  return (kept.length ? kept.join(" ") : cleaned).trim();
}

export function parseIngredient(raw: string): ParsedIngredient {
  const original = raw.trim();
  let text = preclean(original);

  // Some sources glue the leading quantity to what follows: "3pounds russet
  // potatoes", "2tablespoons kosher salt". Split only the leading token, so a
  // name that happens to start with a digit-letter run elsewhere is untouched.
  text = text.replace(/^(\d+(?:\.\d+)?)([a-zA-Z])/, "$1 $2");
  // Likewise a glued numeric range: "3-4 cloves garlic" -> "3 to 4 cloves
  // garlic". Both sides must be plain digits, so a size like "1-inch" (whose
  // right side is a word, not a number) is correctly left alone.
  text = text.replace(/^(\d+)-(\d+)(?=\s|$)/, "$1 to $2");

  const optional = /\boptional\b/i.test(text);

  // Pull out a package size: "1 (14.5 ounce) can diced tomatoes"
  let packSize: number | null = null;
  let packUnit: string | null = null;
  text = text.replace(
    /\(\s*(\d*\.?\d+)\s*(?:-|\s)?\s*([a-zA-Z.]+)\s*\)/,
    (whole, num: string, u: string) => {
      const canon = UNITS[u.toLowerCase().replace(/\.$/, "")];
      if (!canon) return whole; // not a size, e.g. "(optional)"
      packSize = Number(num);
      packUnit = canon;
      return " ";
    },
  );
  text = text.replace(/\s+/g, " ").trim();

  const { head, note } = splitNote(text);
  const tokens = head.split(" ").filter(Boolean);

  const amount = parseAmount(tokens);
  let i = amount.used;

  // Size adjectives sit between the amount and the unit ("8 thick slices bacon");
  // step over them so the unit is still recognised.
  while (tokens[i] && SIZE_WORDS.has(tokens[i].toLowerCase().replace(/[.,]$/, ""))) i++;

  const u = matchUnit(tokens, i);
  let unitName: string | null = null;
  if (u) { unitName = u.unit; i += u.used; }

  // "1 (14.5 ounce) can" — the container word follows the parenthetical
  if (!unitName && packUnit) {
    const u2 = matchUnit(tokens, i);
    if (u2) { unitName = u2.unit; i += u2.used; }
  }

  const rest = tokens.slice(i);
  // Drop size adjectives; they qualify the unit, not the ingredient.
  const nameWords = rest.filter((w) => !SIZE_WORDS.has(w.toLowerCase().replace(/[.,]$/, "")));
  let name = nameWords.join(" ").replace(/^of\s+/i, "").replace(/[.,;]+$/, "").trim();
  if (!name) name = rest.join(" ").trim() || head;

  // A line with no amount, no unit and no prep clause is a section label, not food.
  const isHeading = amount.value === null && !unitName && packSize === null &&
    !note && /^[^\d]{1,40}$/.test(original) && original.split(" ").length <= 4 &&
    (/:$/.test(original) || /^[A-Z]/.test(original));

  return {
    raw: original,
    quantity: amount.value,
    quantityMax: amount.max,
    unit: unitName,
    packSize,
    packUnit,
    name,
    nameNorm: normalizeName(name),
    note,
    optional,
    isHeading,
  };
}

export function parseIngredients(lines: string[]): ParsedIngredient[] {
  return lines.map((l) => parseIngredient(l)).filter((p) => p.raw.length > 0);
}

/** Render a parsed ingredient back to a display string (used by the recipe view). */
export function formatAmount(p: ParsedIngredient): string {
  const bits: string[] = [];
  if (p.quantity !== null) {
    const q = p.quantityMax !== null
      ? `${trimNum(p.quantity)}-${trimNum(p.quantityMax)}`
      : trimNum(p.quantity);
    bits.push(q);
  }
  if (p.packSize !== null) bits.push(`(${trimNum(p.packSize)} ${p.packUnit})`);
  if (p.unit) bits.push(p.quantity !== null && p.quantity !== 1 ? p.unit + "s" : p.unit);
  return bits.join(" ");
}

function trimNum(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
}
