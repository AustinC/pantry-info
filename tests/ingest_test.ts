import { assertEquals, assertThrows } from "@std/assert";
import { Db } from "../src/db.ts";
import { ingestEnvelope, IngestError, parseEnvelope } from "../src/ingest.ts";

function tmpDb(): { db: Db; cleanup: () => void } {
  const dir = Deno.makeTempDirSync({ prefix: "pantry-ingest-" });
  Deno.env.set("PANTRY_INFO_DIR", dir);
  Deno.mkdirSync(`${dir}/pages`, { recursive: true });
  const db = new Db(`${dir}/test.db`);
  return { db, cleanup: () => { db.close(); Deno.removeSync(dir, { recursive: true }); } };
}

const JSONLD = {
  "@type": "Recipe",
  name: "Captured Puttanesca",
  author: { "@type": "Person", name: "Chef John" },
  recipeIngredient: ["2 anchovy fillets, minced", "0.5 cup Kalamata olives"],
  recipeInstructions: [{ "@type": "HowToStep", text: "Cook it." }],
};

const ENVELOPE = {
  pantryInfo: 1,
  url: "https://www.allrecipes.com/recipe/12345/captured-puttanesca/",
  capturedAt: "2026-08-07T00:00:00.000Z",
  jsonld: JSONLD,
};

Deno.test("rejects malformed envelopes", () => {
  assertThrows(() => parseEnvelope(null), IngestError);
  assertThrows(() => parseEnvelope({ ...ENVELOPE, pantryInfo: 99 }), IngestError);
  assertThrows(() => parseEnvelope({ ...ENVELOPE, url: "not-a-url" }), IngestError);
  assertThrows(() => parseEnvelope({ ...ENVELOPE, jsonld: undefined }), IngestError);
  assertThrows(() => parseEnvelope({ ...ENVELOPE, html: 42 }), IngestError);
});

Deno.test("accepts a well-formed envelope", () => {
  const e = parseEnvelope(ENVELOPE);
  assertEquals(e.url, ENVELOPE.url);
  assertEquals(e.capturedAt, ENVELOPE.capturedAt);
});

Deno.test("a captured recipe parses identically to a scraped one", () => {
  const { db, cleanup } = tmpDb();
  try {
    const { recipe: r, updated } = ingestEnvelope(db, parseEnvelope(ENVELOPE));
    assertEquals(updated, false);
    assertEquals(r.title, "Captured Puttanesca");
    assertEquals(r.source, "allrecipes.com");
    assertEquals(r.sourceId, "12345"); // real id, so it dedupes against scrapes
    assertEquals(r.ingredients.length, 2);
    // Same ingredient splitting as the scraper path.
    assertEquals(r.ingredients[0].nameNorm, "anchovy");
    assertEquals(r.ingredients[1].unit, "cup");
    assertEquals(db.stats().recipes, 1);
  } finally {
    cleanup();
  }
});

Deno.test("re-capturing the same page updates instead of duplicating", () => {
  const { db, cleanup } = tmpDb();
  try {
    ingestEnvelope(db, parseEnvelope(ENVELOPE));
    // The same recipe captured again, this time without the trailing slash.
    const second = ingestEnvelope(db, parseEnvelope({
      ...ENVELOPE,
      url: "https://www.allrecipes.com/recipe/12345/captured-puttanesca",
      jsonld: { ...JSONLD, recipeIngredient: ["2 anchovy fillets", "1 cup olives", "3 cloves garlic"] },
    }));
    assertEquals(second.updated, true);
    assertEquals(db.stats().recipes, 1);
    assertEquals(db.stats().ingredients, 3);
  } finally {
    cleanup();
  }
});

Deno.test("reports 'updated' for a page already stored under a slugless URL", () => {
  const { db, cleanup } = tmpDb();
  try {
    // How the HTML-cache import stores it: id only, no slug.
    ingestEnvelope(db, parseEnvelope({
      ...ENVELOPE,
      url: "https://www.allrecipes.com/recipe/12345/",
    }));
    // How the browser capture sees it: full canonical URL. Same recipe.
    const { updated } = ingestEnvelope(db, parseEnvelope(ENVELOPE));
    assertEquals(updated, true);
    assertEquals(db.stats().recipes, 1);
  } finally {
    cleanup();
  }
});

Deno.test("rejects JSON-LD that is not a recipe", () => {
  const { db, cleanup } = tmpDb();
  try {
    assertThrows(
      () => ingestEnvelope(db, parseEnvelope({ ...ENVELOPE, jsonld: { "@type": "WebPage" } })),
      IngestError,
    );
    assertEquals(db.stats().recipes, 0);
  } finally {
    cleanup();
  }
});

Deno.test("caches captured HTML under the recipe's source id", () => {
  const { db, cleanup } = tmpDb();
  try {
    ingestEnvelope(db, parseEnvelope({ ...ENVELOPE, html: "<html>captured</html>" }));
    const dir = Deno.env.get("PANTRY_INFO_DIR")!;
    assertEquals(
      Deno.readTextFileSync(`${dir}/pages/allrecipes.com-12345.html`),
      "<html>captured</html>",
    );
  } finally {
    cleanup();
  }
});

Deno.test("captures from any site, not just allrecipes", () => {
  const { db, cleanup } = tmpDb();
  try {
    const { recipe: r } = ingestEnvelope(db, parseEnvelope({
      ...ENVELOPE,
      url: "https://example.com/recipes/some-stew",
      jsonld: { ...JSONLD, name: "Some Stew", author: { name: "Someone Else" } },
    }));
    assertEquals(r.source, "example.com");
    assertEquals(r.title, "Some Stew");
    assertEquals(r.author, "Someone Else"); // no Chef John gate on manual capture
  } finally {
    cleanup();
  }
});
