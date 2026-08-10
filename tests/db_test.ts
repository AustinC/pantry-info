import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { Db } from "../src/db.ts";
import { buildRecipe, extractRecipeNode } from "../src/scraper.ts";

function tmpDb(): { db: Db; cleanup: () => void } {
  const dir = Deno.makeTempDirSync({ prefix: "pantry-test-" });
  Deno.env.set("PANTRY_INFO_DIR", dir);
  const db = new Db(`${dir}/test.db`);
  return {
    db,
    cleanup: () => {
      db.close();
      Deno.removeSync(dir, { recursive: true });
    },
  };
}

function makeRecipe(id: string, title: string, ingredients: string[], url?: string) {
  const node = {
    "@type": "Recipe",
    name: title,
    author: { name: "Chef John" },
    recipeIngredient: ingredients,
    recipeInstructions: [{ "@type": "HowToStep", text: "Cook it." }],
  };
  return buildRecipe(node, url ?? `https://www.allrecipes.com/recipe/${id}/${title.toLowerCase().replace(/\W+/g, "-")}/`)!;
}

Deno.test("stores a recipe with its ingredients split apart", () => {
  const { db, cleanup } = tmpDb();
  try {
    const id = db.upsertRecipe(makeRecipe("1", "Puttanesca", [
      "2 anchovy fillets, minced",
      "0.5 cup pitted Kalamata olives",
      "For the sauce:",
    ]));
    const ings = db.getIngredients(id);
    assertEquals(ings.length, 3);
    assertEquals(ings[0].name_norm, "anchovy");
    assertEquals(ings[0].quantity, 2);
    assertEquals(ings[1].unit, "cup");
    assertEquals(ings[2].is_heading, 1);
    // Headings are excluded from the ingredient count.
    assertEquals(db.stats().ingredients, 2);
  } finally {
    cleanup();
  }
});

Deno.test("re-scraping a recipe updates rather than duplicates it", () => {
  const { db, cleanup } = tmpDb();
  try {
    db.upsertRecipe(makeRecipe("1", "Puttanesca", ["2 anchovy fillets"]));
    db.upsertRecipe(makeRecipe("1", "Puttanesca", ["2 anchovy fillets", "1 cup olives"]));
    assertEquals(db.stats().recipes, 1);
    assertEquals(db.stats().ingredients, 2); // old rows replaced, not appended
  } finally {
    cleanup();
  }
});

Deno.test("the discovery queue advances and never re-serves stored recipes", () => {
  const { db, cleanup } = tmpDb();
  try {
    db.addDiscovered([
      { url: "https://www.allrecipes.com/recipe/1/chef-johns-pasta-one/", sourceId: "1", slug: "chef-johns-pasta-one" },
      { url: "https://www.allrecipes.com/recipe/2/chef-johns-pasta-two/", sourceId: "2", slug: "chef-johns-pasta-two" },
    ], "pasta");
    assertEquals(db.pendingForKeyword("pasta", 10).length, 2);

    db.upsertRecipe(makeRecipe("1", "Chef Johns Pasta One", ["1 cup flour"]));
    const pending = db.pendingForKeyword("pasta", 10);
    assertEquals(pending.length, 1);
    assertEquals(pending[0].slug, "chef-johns-pasta-two");
  } finally {
    cleanup();
  }
});

Deno.test("a URL discovered without a trailing slash still counts as scraped", () => {
  const { db, cleanup } = tmpDb();
  try {
    // Search results omit the trailing slash; the page's JSON-LD includes it.
    db.addDiscovered(
      [{ url: "https://www.allrecipes.com/recipe/7/chef-johns-thing/", sourceId: "7", slug: "chef-johns-thing" }],
      "thing",
    );
    db.upsertRecipe(makeRecipe("7", "Chef Johns Thing", ["1 cup flour"]));
    assertEquals(db.stats().pending, 0);
    assertEquals(db.pendingForKeyword("thing", 10).length, 0);
  } finally {
    cleanup();
  }
});

Deno.test("ranks recipes by how many pantry ingredients they use", () => {
  const { db, cleanup } = tmpDb();
  try {
    db.upsertRecipe(makeRecipe("1", "Puttanesca", [
      "2 anchovy fillets", "0.5 cup Kalamata olives", "3 cloves garlic",
    ]));
    db.upsertRecipe(makeRecipe("2", "Olive Bread", ["1 cup olives", "2 cups flour"]));
    db.upsertRecipe(makeRecipe("3", "Plain Toast", ["2 slices bread"]));

    const hits = db.byIngredients(["anchovy", "olive"]);
    assertEquals(hits[0].title, "Puttanesca");
    assertEquals(hits[0].matched, 2);
    assertEquals(hits.length, 2); // Plain Toast uses neither
  } finally {
    cleanup();
  }
});

Deno.test("the same recipe under two URL spellings updates one row", () => {
  const { db, cleanup } = tmpDb();
  try {
    // As imported from the HTML cache: no slug.
    db.upsertRecipe(makeRecipe("220435", "Peanut Butter Cookies", ["1 cup peanut butter"],
      "https://www.allrecipes.com/recipe/220435/"));
    // The same page later captured or scraped, this time with its slug.
    db.upsertRecipe(makeRecipe("220435", "Peanut Butter Cookies",
      ["1 cup peanut butter", "1 cup sugar"],
      "https://www.allrecipes.com/recipe/220435/chef-johns-peanut-butter-cookies/"));

    assertEquals(db.stats().recipes, 1);
    assertEquals(db.stats().ingredients, 2);
    // The fuller, canonical URL wins.
    const row = db.getRecipe(db.searchIndex()[0].id)!;
    assertEquals(row.url, "https://www.allrecipes.com/recipe/220435/chef-johns-peanut-butter-cookies/");
  } finally {
    cleanup();
  }
});

Deno.test("stars toggle and are reported in the search index", () => {
  const { db, cleanup } = tmpDb();
  try {
    const id = db.upsertRecipe(makeRecipe("1", "Puttanesca", ["1 cup olives"]));
    assertEquals(db.searchIndex()[0].starred, 0);
    assertEquals(db.stats().starred, 0);

    assertEquals(db.toggleStar(id), true);
    assertEquals(db.searchIndex()[0].starred, 1);
    assertEquals(db.getRecipe(id)!.starred, 1);
    assertEquals(db.stats().starred, 1);

    assertEquals(db.toggleStar(id), false);
    assertEquals(db.stats().starred, 0);
  } finally {
    cleanup();
  }
});

Deno.test("a star survives re-scraping the recipe", () => {
  const { db, cleanup } = tmpDb();
  try {
    const id = db.upsertRecipe(makeRecipe("1", "Puttanesca", ["1 cup olives"]));
    db.setStar(id, true);
    // Re-scrape: the row is updated in place, and the user's star must persist.
    db.upsertRecipe(makeRecipe("1", "Puttanesca", ["1 cup olives", "2 anchovy fillets"]));
    assertEquals(db.getRecipe(id)!.starred, 1);
  } finally {
    cleanup();
  }
});

Deno.test("notes save, clear, and reach the search index", () => {
  const { db, cleanup } = tmpDb();
  try {
    const id = db.upsertRecipe(makeRecipe("1", "Puttanesca", ["1 cup olives"]));
    assertEquals(db.getRecipe(id)!.note, null);

    db.setNote(id, "  Use double anchovies. Mum's favourite.  ");
    assertEquals(db.getRecipe(id)!.note, "Use double anchovies. Mum's favourite.");
    assertEquals(db.searchIndex()[0].note, "Use double anchovies. Mum's favourite.");

    db.setNote(id, "line one\nline two"); // newlines survive
    assertEquals(db.getRecipe(id)!.note, "line one\nline two");

    db.setNote(id, "   "); // whitespace-only clears the note
    assertEquals(db.getRecipe(id)!.note, null);
  } finally {
    cleanup();
  }
});

Deno.test("setTitle renames a recipe and reaches the search index", () => {
  const { db, cleanup } = tmpDb();
  try {
    const id = db.upsertRecipe(makeRecipe("1", "Puttanesca", ["1 cup olives"]));
    db.setTitle(id, "  Mum's Puttanesca  ");
    assertEquals(db.getRecipe(id)!.title, "Mum's Puttanesca");
    assertEquals(db.searchIndex()[0].title, "Mum's Puttanesca");
  } finally {
    cleanup();
  }
});

Deno.test("a renamed title survives re-scraping the recipe", () => {
  const { db, cleanup } = tmpDb();
  try {
    const id = db.upsertRecipe(makeRecipe("1", "Puttanesca", ["1 cup olives"]));
    db.setTitle(id, "Mum's Puttanesca");
    // Re-scraping updates the site's fields; the user's rename must survive it
    // exactly like a star or a note does — same "user annotation" contract.
    db.upsertRecipe(makeRecipe("1", "Puttanesca", ["1 cup olives", "2 anchovy fillets"]));
    assertEquals(db.getRecipe(id)!.title, "Mum's Puttanesca");
  } finally {
    cleanup();
  }
});

Deno.test("a note survives re-scraping the recipe", () => {
  const { db, cleanup } = tmpDb();
  try {
    const id = db.upsertRecipe(makeRecipe("1", "Puttanesca", ["1 cup olives"]));
    db.setNote(id, "halve the salt");
    db.setStar(id, true);
    // Re-scraping overwrites the site's fields but must not touch the user's own.
    db.upsertRecipe(makeRecipe("1", "Puttanesca", ["1 cup olives", "2 anchovy fillets"]));
    const row = db.getRecipe(id)!;
    assertEquals(row.note, "halve the salt");
    assertEquals(row.starred, 1);
  } finally {
    cleanup();
  }
});

Deno.test("adds the starred column to a database created before the feature", () => {
  const dir = Deno.makeTempDirSync({ prefix: "pantry-migrate-" });
  Deno.env.set("PANTRY_INFO_DIR", dir);
  const path = `${dir}/old.db`;
  try {
    // A minimal pre-migration recipes table, as an older build would have left it.
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_id TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, author TEXT, description TEXT,
      category TEXT, cuisine TEXT, keywords TEXT, prep_time TEXT, cook_time TEXT,
      total_time TEXT, servings TEXT, rating REAL, rating_count INTEGER, image TEXT,
      instructions TEXT NOT NULL DEFAULT '[]', nutrition TEXT, scraped_at TEXT NOT NULL,
      UNIQUE (source, source_id))`);
    legacy.prepare(
      `INSERT INTO recipes (source, source_id, url, title, scraped_at)
       VALUES ('allrecipes.com','1','https://www.allrecipes.com/recipe/1/x/','Old One','now')`,
    ).run();
    legacy.close();

    const db = new Db(path); // constructor migrates
    assertEquals(db.stats().recipes, 1);
    assertEquals(db.searchIndex()[0].starred, 0);
    assertEquals(db.searchIndex()[0].note, null);
    const id = db.searchIndex()[0].id;
    assertEquals(db.toggleStar(id), true);
    db.setNote(id, "works after migrating");
    assertEquals(db.getRecipe(id)!.note, "works after migrating");

    // title_custom is a later migration than starred/note — added to the same
    // pre-migration table to confirm migrations compose, not just apply solo.
    assertEquals(db.getRecipe(id)!.title_custom, 0);
    db.setTitle(id, "Renamed After Migrating");
    assertEquals(db.getRecipe(id)!.title, "Renamed After Migrating");
    assertEquals(db.getRecipe(id)!.title_custom, 1);
    db.close();

    // Re-opening an already-migrated database must be a no-op, not an error.
    const again = new Db(path);
    assertEquals(again.getRecipe(id)!.note, "works after migrating");
    assertEquals(again.getRecipe(id)!.title, "Renamed After Migrating");
    again.close();
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("distinctIngredientNames lists each normalised name once, most-used first", () => {
  const { db, cleanup } = tmpDb();
  try {
    db.upsertRecipe(makeRecipe("1", "Puttanesca", ["2 anchovy fillets", "1 cup olives, pitted"]));
    db.upsertRecipe(makeRecipe("2", "Salad Niçoise", ["3 anchovy fillets", "2 eggs"]));
    db.upsertRecipe(makeRecipe("3", "Deviled Eggs", ["6 eggs"]));

    const names = db.distinctIngredientNames();
    // anchovy and egg tie at count 2; ties break alphabetically.
    assertEquals(names.map((n) => n.nameNorm), ["anchovy", "egg", "olive"]);
    assertEquals(names.find((n) => n.nameNorm === "egg")!.count, 2);
    assertEquals(names.find((n) => n.nameNorm === "olive")!.count, 1);
  } finally {
    cleanup();
  }
});

Deno.test("recipesByIngredientNames ranks by percentage of ingredients on hand", () => {
  const { db, cleanup } = tmpDb();
  try {
    // 2/2 ingredients on hand — a full match despite being a small recipe.
    db.upsertRecipe(makeRecipe("1", "Anchovy Toast", ["2 anchovy fillets", "1 slice bread"]));
    // 1/3 on hand — matches, but weakly.
    db.upsertRecipe(makeRecipe("2", "Puttanesca", [
      "2 anchovy fillets", "1 cup olives", "3 cloves garlic",
    ]));
    // Uses none of the picked ingredients — must not appear at all.
    db.upsertRecipe(makeRecipe("3", "Scrambled Eggs", ["2 eggs"]));

    const ranked = db.recipesByIngredientNames(["anchovy", "bread"]);
    assertEquals(ranked.map((r) => r.title), ["Anchovy Toast", "Puttanesca"]);
    assertEquals(ranked[0].matched, 2);
    assertEquals(ranked[0].total, 2);
    assertEquals(ranked[0].missing, []);
    assertEquals(ranked[1].matched, 1);
    assertEquals(ranked[1].total, 3);
    assertEquals(new Set(ranked[1].missing), new Set(["olive", "garlic"]));
  } finally {
    cleanup();
  }
});

Deno.test("recipesByIngredientNames returns nothing for an empty selection", () => {
  const { db, cleanup } = tmpDb();
  try {
    db.upsertRecipe(makeRecipe("1", "Anchovy Toast", ["2 anchovy fillets"]));
    assertEquals(db.recipesByIngredientNames([]), []);
  } finally {
    cleanup();
  }
});

Deno.test("recipesByIngredientNames lists each missing ingredient once", () => {
  const { db, cleanup } = tmpDb();
  try {
    // "onion" appears twice — once for the filling, once for the garnish.
    db.upsertRecipe(makeRecipe("1", "Stuffed Peppers", [
      "1 onion, diced", "1 onion, sliced for garnish", "1 pound ground beef",
    ]));
    const [r] = db.recipesByIngredientNames(["beef"]); // "ground" is stripped as a prep word
    assertEquals(r.missing, ["onion"]);
  } finally {
    cleanup();
  }
});

Deno.test("the have-ingredients list persists across Db instances", () => {
  const dir = Deno.makeTempDirSync({ prefix: "pantry-have-" });
  Deno.env.set("PANTRY_INFO_DIR", dir);
  const path = `${dir}/have.db`;
  try {
    const first = new Db(path);
    assertEquals(first.getHaveIngredients(), []);
    first.addHaveIngredient("garlic");
    first.addHaveIngredient("anchovy");
    assertEquals(first.getHaveIngredients(), ["garlic", "anchovy"]); // insertion order
    first.close();

    // A fresh Db instance — simulating a relaunch of the app — sees the same list.
    const second = new Db(path);
    assertEquals(second.getHaveIngredients(), ["garlic", "anchovy"]);
    second.removeHaveIngredient("garlic");
    assertEquals(second.getHaveIngredients(), ["anchovy"]);
    second.close();

    const third = new Db(path);
    assertEquals(third.getHaveIngredients(), ["anchovy"]);
    third.close();
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("adding the same have-ingredient twice does not duplicate or reorder it", () => {
  const { db, cleanup } = tmpDb();
  try {
    db.addHaveIngredient("garlic");
    db.addHaveIngredient("onion");
    db.addHaveIngredient("garlic"); // re-adding must not move it to the end
    assertEquals(db.getHaveIngredients(), ["garlic", "onion"]);
  } finally {
    cleanup();
  }
});

Deno.test("extracts an id even from a slugless cached URL", () => {
  const { db, cleanup } = tmpDb();
  try {
    const r = makeRecipe("261198", "Cached Recipe", ["1 cup flour"], "https://www.allrecipes.com/recipe/261198/");
    assertEquals(r.sourceId, "261198");
    db.upsertRecipe(r);
    assertEquals(db.hasSourceId("allrecipes.com", "261198"), true);
  } finally {
    cleanup();
  }
});
