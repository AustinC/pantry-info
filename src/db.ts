/**
 * SQLite storage.
 *
 * Ingredients live in their own table with amount split from name, so the planned
 * "what can I cook with what's on hand?" query is a plain join on `name_norm`
 * rather than a text scrape of a stored blob.
 *
 * `discovered` is a keyword-indexed list of recipe URLs we have *seen* but not
 * necessarily downloaded. It lets a keyword scrape pick up where it left off:
 * search once, then pull N new recipes at a time across sessions.
 */

import { DatabaseSync } from "node:sqlite";
import { dbPath, ensureDirs } from "./paths.ts";
import type { ScrapedRecipe } from "./scraper.ts";
import type { ParsedIngredient } from "./ingredients.ts";

export interface RecipeRow {
  id: number;
  source: string;
  source_id: string;
  url: string;
  title: string;
  author: string | null;
  description: string | null;
  category: string | null;
  cuisine: string | null;
  keywords: string | null;
  prep_time: string | null;
  cook_time: string | null;
  total_time: string | null;
  servings: string | null;
  rating: number | null;
  rating_count: number | null;
  image: string | null;
  instructions: string;
  nutrition: string | null;
  scraped_at: string;
  starred: number;
  /** The user's own free-text note, shown between ingredients and instructions. */
  note: string | null;
}

export interface IngredientRow {
  id: number;
  recipe_id: number;
  position: number;
  raw: string;
  quantity: number | null;
  quantity_max: number | null;
  unit: string | null;
  pack_size: number | null;
  pack_unit: string | null;
  name: string;
  name_norm: string;
  note: string | null;
  optional: number;
  is_heading: number;
}

/** Lightweight row used for in-memory fuzzy ranking. */
export interface SearchRow {
  id: number;
  title: string;
  category: string | null;
  cuisine: string | null;
  description: string | null;
  keywords: string | null;
  author: string | null;
  rating: number | null;
  total_time: string | null;
  ingredient_names: string;
  /** 1 when the user has starred this recipe; starred recipes sort first. */
  starred: number;
  note: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS recipes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  url           TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  author        TEXT,
  description   TEXT,
  category      TEXT,
  cuisine       TEXT,
  keywords      TEXT,
  prep_time     TEXT,
  cook_time     TEXT,
  total_time    TEXT,
  servings      TEXT,
  rating        REAL,
  rating_count  INTEGER,
  image         TEXT,
  instructions  TEXT NOT NULL DEFAULT '[]',
  nutrition     TEXT,
  scraped_at    TEXT NOT NULL,
  starred       INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  UNIQUE (source, source_id)
);
-- No index on the starred column here: on a database created before that column
-- existed, CREATE TABLE IF NOT EXISTS is a no-op and the index would reference a
-- missing column. The migration adds the column and the index together.

CREATE TABLE IF NOT EXISTS ingredients (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id    INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  raw          TEXT NOT NULL,
  quantity     REAL,
  quantity_max REAL,
  unit         TEXT,
  pack_size    REAL,
  pack_unit    TEXT,
  name         TEXT NOT NULL,
  name_norm    TEXT NOT NULL,
  note         TEXT,
  optional     INTEGER NOT NULL DEFAULT 0,
  is_heading   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ing_recipe ON ingredients(recipe_id);
CREATE INDEX IF NOT EXISTS idx_ing_norm   ON ingredients(name_norm);

-- Recipe URLs seen in search results, with the keyword that surfaced them.
CREATE TABLE IF NOT EXISTS discovered (
  url         TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  slug        TEXT,
  keyword     TEXT,
  first_seen  TEXT NOT NULL,
  scraped     INTEGER NOT NULL DEFAULT 0,
  skipped     TEXT
);
CREATE INDEX IF NOT EXISTS idx_disc_kw ON discovered(keyword, scraped);

-- Keyword history, so the UI can show what has already been mined.
CREATE TABLE IF NOT EXISTS keyword_runs (
  keyword    TEXT PRIMARY KEY,
  last_run   TEXT NOT NULL,
  found      INTEGER NOT NULL DEFAULT 0,
  scraped    INTEGER NOT NULL DEFAULT 0
);
`;

export class Db {
  #db: DatabaseSync;

  constructor(path?: string) {
    ensureDirs();
    this.#db = new DatabaseSync(path ?? dbPath());
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(SCHEMA);
    this.#migrate();
  }

  /**
   * Bring an older database up to date. CREATE TABLE IF NOT EXISTS leaves existing
   * tables untouched, so columns added after a database was first created have to
   * be applied separately.
   */
  #migrate(): void {
    const columns = new Set(
      (this.#db.prepare("PRAGMA table_info(recipes)").all() as unknown as { name: string }[])
        .map((c) => c.name),
    );
    if (!columns.has("starred")) {
      this.#db.exec("ALTER TABLE recipes ADD COLUMN starred INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.has("note")) {
      this.#db.exec("ALTER TABLE recipes ADD COLUMN note TEXT");
    }
    this.#db.exec("CREATE INDEX IF NOT EXISTS idx_recipes_starred ON recipes(starred)");
  }

  close(): void {
    this.#db.close();
  }

  get raw(): DatabaseSync {
    return this.#db;
  }

  // -- writes --------------------------------------------------------------

  /**
   * Insert or update a recipe and its ingredients. Returns the recipe id.
   *
   * A recipe has two independent identities — its URL and its (source, source_id) —
   * and the same page can arrive under different URL spellings: slugless from the
   * HTML cache, slugged from a search result or a browser capture. Matching on
   * either and updating by row id means whichever arrives second refreshes the
   * existing row instead of tripping a UNIQUE constraint.
   */
  upsertRecipe(r: ScrapedRecipe): number {
    const now = new Date().toISOString();
    const cols = [
      r.source, r.sourceId, r.url, r.title, r.author, r.description,
      r.category.join(", ") || null, r.cuisine.join(", ") || null,
      r.keywords.join(", ") || null, r.prepTime, r.cookTime, r.totalTime, r.servings,
      r.rating, r.ratingCount, r.image, JSON.stringify(r.instructions),
      r.nutrition ? JSON.stringify(r.nutrition) : null, now,
    ];

    const existing = this.#db.prepare(
      "SELECT id FROM recipes WHERE url = ? OR (source = ? AND source_id = ?)",
    ).get(r.url, r.source, r.sourceId) as { id: number } | undefined;

    let id: number;
    if (existing) {
      // Adopt the incoming URL: a slugged canonical URL beats a rebuilt slugless one.
      this.#db.prepare(
        `UPDATE recipes SET source=?, source_id=?, url=?, title=?, author=?, description=?,
           category=?, cuisine=?, keywords=?, prep_time=?, cook_time=?, total_time=?,
           servings=?, rating=?, rating_count=?, image=?, instructions=?, nutrition=?,
           scraped_at=? WHERE id=?`,
      ).run(...cols as never[], existing.id);
      id = Number(existing.id);
    } else {
      this.#db.prepare(
        `INSERT INTO recipes (source, source_id, url, title, author, description, category,
           cuisine, keywords, prep_time, cook_time, total_time, servings, rating,
           rating_count, image, instructions, nutrition, scraped_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(...cols as never[]);
      const row = this.#db.prepare("SELECT id FROM recipes WHERE url = ?").get(r.url) as
        | { id: number }
        | undefined;
      if (!row) throw new Error(`failed to persist recipe ${r.url}`);
      id = Number(row.id);
    }

    this.#db.prepare("DELETE FROM ingredients WHERE recipe_id = ?").run(id);
    const ins = this.#db.prepare(
      `INSERT INTO ingredients (recipe_id, position, raw, quantity, quantity_max, unit,
         pack_size, pack_unit, name, name_norm, note, optional, is_heading)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    r.ingredients.forEach((p: ParsedIngredient, i: number) => {
      ins.run(
        id, i, p.raw, p.quantity, p.quantityMax, p.unit, p.packSize, p.packUnit,
        p.name, p.nameNorm, p.note, p.optional ? 1 : 0, p.isHeading ? 1 : 0,
      );
    });

    this.markDiscoveredScraped(r.url, r.source, r.sourceId);
    return id;
  }

  /** Record search hits. Returns how many were new to the table. */
  addDiscovered(
    items: { url: string; sourceId: string; slug: string }[],
    keyword: string,
    source = "allrecipes.com",
  ): number {
    const now = new Date().toISOString();
    const stmt = this.#db.prepare(
      `INSERT INTO discovered (url, source, source_id, slug, keyword, first_seen)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(url) DO NOTHING`,
    );
    let added = 0;
    for (const it of items) {
      const res = stmt.run(it.url, source, it.sourceId, it.slug, keyword, now);
      if (Number(res.changes) > 0) added++;
    }
    return added;
  }

  /**
   * Mark a discovered row done. Keyed on (source, source_id) as well as url,
   * because the URL that surfaced in search results and the canonical URL from
   * the page's JSON-LD are often different spellings of the same recipe.
   */
  markDiscoveredScraped(url: string, source?: string, sourceId?: string): void {
    this.#db.prepare("UPDATE discovered SET scraped = 1, skipped = NULL WHERE url = ?").run(url);
    if (source && sourceId) {
      this.#db.prepare(
        "UPDATE discovered SET scraped = 1, skipped = NULL WHERE source = ? AND source_id = ?",
      ).run(source, sourceId);
    }
  }

  markDiscoveredSkipped(url: string, reason: string): void {
    this.#db.prepare("UPDATE discovered SET skipped = ? WHERE url = ?").run(reason, url);
  }

  recordKeywordRun(keyword: string, found: number, scraped: number): void {
    this.#db.prepare(
      `INSERT INTO keyword_runs (keyword, last_run, found, scraped) VALUES (?,?,?,?)
       ON CONFLICT(keyword) DO UPDATE SET
         last_run = excluded.last_run,
         found    = keyword_runs.found + excluded.found,
         scraped  = keyword_runs.scraped + excluded.scraped`,
    ).run(keyword, new Date().toISOString(), found, scraped);
  }

  // -- reads ---------------------------------------------------------------

  hasUrl(url: string): boolean {
    return !!this.#db.prepare("SELECT 1 FROM recipes WHERE url = ?").get(url);
  }

  hasSourceId(source: string, sourceId: string): boolean {
    return !!this.#db.prepare(
      "SELECT 1 FROM recipes WHERE source = ? AND source_id = ?",
    ).get(source, sourceId);
  }

  /**
   * Queue of discovered-but-unscraped URLs for a keyword, best candidates first
   * (slug containing the keyword wins, since allrecipes search mixes in loosely
   * related results).
   */
  pendingForKeyword(keyword: string, limit: number): { url: string; slug: string }[] {
    const kw = keyword.toLowerCase().replace(/\s+/g, "-");
    return this.#db.prepare(
      `SELECT d.url, d.slug FROM discovered d
        WHERE d.scraped = 0
          AND d.skipped IS NULL
          AND NOT EXISTS (
                SELECT 1 FROM recipes r
                 WHERE r.url = d.url
                    OR (r.source = d.source AND r.source_id = d.source_id))
          AND (d.keyword = ? OR d.slug LIKE ?)
        ORDER BY (d.slug LIKE ?) DESC,
                 (d.slug LIKE 'chef-johns-%') DESC,
                 d.first_seen ASC
        LIMIT ?`,
    ).all(keyword, `%${kw}%`, `%${kw}%`, limit) as { url: string; slug: string }[];
  }

  /** Flip a recipe's star. Returns the new state. */
  toggleStar(id: number): boolean {
    this.#db.prepare("UPDATE recipes SET starred = 1 - starred WHERE id = ?").run(id);
    const row = this.#db.prepare("SELECT starred FROM recipes WHERE id = ?").get(id) as
      | { starred: number }
      | undefined;
    return !!row?.starred;
  }

  setStar(id: number, starred: boolean): void {
    this.#db.prepare("UPDATE recipes SET starred = ? WHERE id = ?").run(starred ? 1 : 0, id);
  }

  /** Save the user's note. An empty note clears it. */
  setNote(id: number, note: string | null): void {
    const trimmed = note?.trim();
    this.#db.prepare("UPDATE recipes SET note = ? WHERE id = ?").run(trimmed || null, id);
  }

  searchIndex(): SearchRow[] {
    return this.#db.prepare(
      `SELECT r.id, r.title, r.category, r.cuisine, r.description, r.keywords,
              r.author, r.rating, r.total_time, r.starred, r.note,
              COALESCE((SELECT group_concat(i.name, ' | ')
                          FROM ingredients i
                         WHERE i.recipe_id = r.id AND i.is_heading = 0), '') AS ingredient_names
         FROM recipes r`,
    ).all() as unknown as SearchRow[];
  }

  getRecipe(id: number): RecipeRow | undefined {
    return this.#db.prepare("SELECT * FROM recipes WHERE id = ?").get(id) as
      | RecipeRow
      | undefined;
  }

  getIngredients(recipeId: number): IngredientRow[] {
    return this.#db.prepare(
      "SELECT * FROM ingredients WHERE recipe_id = ? ORDER BY position",
    ).all(recipeId) as unknown as IngredientRow[];
  }

  stats(): {
    recipes: number;
    ingredients: number;
    discovered: number;
    pending: number;
    starred: number;
  } {
    const one = (sql: string) => Number((this.#db.prepare(sql).get() as { n: number }).n);
    return {
      recipes: one("SELECT COUNT(*) AS n FROM recipes"),
      ingredients: one("SELECT COUNT(*) AS n FROM ingredients WHERE is_heading = 0"),
      discovered: one("SELECT COUNT(*) AS n FROM discovered"),
      pending: one("SELECT COUNT(*) AS n FROM discovered WHERE scraped = 0"),
      starred: one("SELECT COUNT(*) AS n FROM recipes WHERE starred = 1"),
    };
  }

  keywordHistory(): { keyword: string; last_run: string; scraped: number }[] {
    return this.#db.prepare(
      "SELECT keyword, last_run, scraped FROM keyword_runs ORDER BY last_run DESC LIMIT 20",
    ).all() as unknown as { keyword: string; last_run: string; scraped: number }[];
  }

  /**
   * Deferred feature, storage-ready: recipes ranked by how many of the given
   * pantry ingredients they use. Matching is on `name_norm`, with a substring
   * fallback so "olive" finds "kalamata olive".
   */
  byIngredients(
    pantry: string[],
    limit = 40,
  ): { id: number; title: string; matched: number; total: number; matches: string }[] {
    if (pantry.length === 0) return [];
    const terms = pantry.map((p) => p.toLowerCase().trim()).filter(Boolean);
    const clause = terms.map(() => "(i.name_norm = ? OR i.name_norm LIKE ?)").join(" OR ");
    const params: unknown[] = [];
    for (const t of terms) params.push(t, `%${t}%`);
    params.push(limit);
    return this.#db.prepare(
      `SELECT r.id, r.title,
              COUNT(DISTINCT i.name_norm) AS matched,
              (SELECT COUNT(*) FROM ingredients x
                WHERE x.recipe_id = r.id AND x.is_heading = 0) AS total,
              group_concat(DISTINCT i.name_norm) AS matches
         FROM ingredients i
         JOIN recipes r ON r.id = i.recipe_id
        WHERE i.is_heading = 0 AND (${clause})
        GROUP BY r.id
        ORDER BY matched DESC, total ASC
        LIMIT ?`,
    ).all(...params as never[]) as unknown as {
      id: number;
      title: string;
      matched: number;
      total: number;
      matches: string;
    }[];
  }
}
