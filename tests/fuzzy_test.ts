import { assert, assertEquals } from "@std/assert";
import { search } from "../src/fuzzy.ts";
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

Deno.test("starred recipes sort first, ahead of any stronger match", () => {
  // Unstarred, row 1 ranks above row 3 for this query.
  assertEquals(search(ROWS, "chef mushroom").map((m) => m.row.id), [1]);
  assertEquals(search(ROWS, "chef")[0].row.id, 1);

  const starred = ROWS.map((r) => r.id === 3 ? { ...r, starred: 1 } : r);
  const hits = search(starred, "chef");
  assertEquals(hits[0].row.id, 3); // starred wins outright
  assertEquals(hits[1].row.id, 1);
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
