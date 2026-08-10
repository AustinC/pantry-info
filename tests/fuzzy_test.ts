import { assert, assertEquals } from "@std/assert";
import { rankStrings, search } from "../src/fuzzy.ts";
import type { SearchRow } from "../src/db.ts";

function row(id: number, title: string, extra: Partial<SearchRow> = {}): SearchRow {
  return {
    id,
    title,
    category: null,
    cuisine: null,
    description: null,
    keywords: null,
    author: "Chef John",
    rating: null,
    total_time: null,
    ingredient_names: "",
    starred: 0,
    note: null,
    ...extra,
  };
}

const ROWS: SearchRow[] = [
  row(1, "Chef John's Creamy Mushroom Pasta"),
  row(2, "Classic Meatloaf"),
  row(3, "Chef John's Spaghetti alla Carbonara"),
  row(4, "Homemade Hamburger Buns"),
  row(5, "Puttanesca", { ingredient_names: "anchovy fillets | kalamata olives | capers" }),
];

Deno.test("ranks exact substring matches first", () => {
  assertEquals(search(ROWS, "pasta")[0].row.id, 1);
});

Deno.test("tolerates a typo by anchoring on the best start position", () => {
  // The 'm' in "Creamy" is an earlier but worse anchor than the one in "Mushroom".
  assertEquals(search(ROWS, "musroom")[0].row.id, 1);
});

Deno.test("matches ingredients, not just titles", () => {
  assertEquals(search(ROWS, "anchovy")[0].row.id, 5);
  assertEquals(search(ROWS, "capers")[0].row.id, 5);
});

Deno.test("ANDs multiple terms", () => {
  assertEquals(search(ROWS, "anchovy olives")[0].row.id, 5);
  assertEquals(search(ROWS, "anchovy zzzz").length, 0);
});

Deno.test("returns everything for an empty query", () => {
  assertEquals(search(ROWS, "").length, ROWS.length);
});

Deno.test("starring does not change ranked search order", () => {
  // Unstarred baseline: row 1 outranks row 3 for "chef" (stronger title match).
  const before = search(ROWS, "chef").map((m) => m.row.id);
  assertEquals(before[0], 1);

  // Starring row 3 must not move it up — starring only affects the empty query.
  const starred = ROWS.map((r) => r.id === 3 ? { ...r, starred: 1 } : r);
  const after = search(starred, "chef").map((m) => m.row.id);
  assertEquals(after, before);
});

Deno.test("starring does not make a non-matching recipe appear", () => {
  const starred = ROWS.map((r) => r.id === 2 ? { ...r, starred: 1 } : r);
  // Classic Meatloaf is starred but cannot match "anchovy" — it stays out.
  assertEquals(search(starred, "anchovy").map((m) => m.row.id), [5]);
});

Deno.test("a user's note makes a recipe findable by their own words", () => {
  const noted = ROWS.map((r) => r.id === 2 ? { ...r, note: "birthday dinner for Sam" } : r);
  assertEquals(search(noted, "birthday")[0].row.id, 2);
  assertEquals(search(ROWS, "birthday").length, 0); // nothing matches without the note
});

Deno.test("starred recipes lead the empty-query listing", () => {
  const starred = ROWS.map((r) => r.id === 4 ? { ...r, starred: 1 } : r);
  assertEquals(search(starred, "")[0].row.id, 4);
});

Deno.test("returns nothing when a term cannot match", () => {
  assertEquals(search(ROWS, "xylophone").length, 0);
});

Deno.test("reports title hit positions for highlighting", () => {
  const m = search(ROWS, "carbonara")[0];
  assert(m.titleHits.length > 0);
  const matched = m.titleHits.map((i) => m.row.title[i]).join("").toLowerCase();
  assertEquals(matched, "carbonara");
});

// -- rankStrings: backs the ingredient-search picker --------------------------

const INGREDIENT_NAMES = [
  "sugar",
  "brown sugar",
  "powdered sugar",
  "kalamata olive",
  "olive oil",
  "anchovy",
];

Deno.test("rankStrings finds every plausible match for a query", () => {
  const hits = rankStrings(INGREDIENT_NAMES, "sugar").map((m) => m.text);
  assertEquals(new Set(hits), new Set(["sugar", "brown sugar", "powdered sugar"]));
});

Deno.test("rankStrings ranks an exact match above a substring match", () => {
  const hits = rankStrings(INGREDIENT_NAMES, "sugar");
  assertEquals(hits[0].text, "sugar");
});

Deno.test("rankStrings supports multi-word queries", () => {
  assertEquals(rankStrings(INGREDIENT_NAMES, "olive oil").map((m) => m.text), ["olive oil"]);
});

Deno.test("rankStrings returns items unranked (score 0) for an empty query", () => {
  const hits = rankStrings(INGREDIENT_NAMES, "");
  assertEquals(hits.map((m) => m.text), INGREDIENT_NAMES);
  assert(hits.every((m) => m.score === 0 && m.hits.length === 0));
});

Deno.test("rankStrings excludes items that don't match", () => {
  assertEquals(rankStrings(INGREDIENT_NAMES, "zzzz"), []);
});
