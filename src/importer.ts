/**
 * Offline bootstrap.
 *
 * The existing Python scraper (~/box/chefjohn) left a cache of raw recipe HTML.
 * Re-parsing it costs no network requests and gives the DB a useful starting set,
 * so a first run isn't an empty screen.
 */

import { Db } from "./db.ts";
import { legacyChefJohnDir, pagesDir } from "./paths.ts";
import { buildRecipe, extractRecipeNode, isChefJohn } from "./scraper.ts";
import type { Progress } from "./jobs.ts";

export interface ImportResult {
  scanned: number;
  imported: number;
  skippedAuthor: number;
  noRecipe: number;
}

/**
 * Import cached HTML into the DB.
 * @param dir      directory of *.html files (defaults to the Python scraper's cache)
 * @param onlyChefJohn keep only pages whose JSON-LD author is Chef John
 */
export function importCachedPages(
  db: Db,
  progress: Progress,
  dir = legacyChefJohnDir() + "/pages",
  onlyChefJohn = true,
): ImportResult {
  const res: ImportResult = { scanned: 0, imported: 0, skippedAuthor: 0, noRecipe: 0 };

  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    progress(`no cache directory at ${dir}`, "warn");
    return res;
  }

  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".html")) continue;
    res.scanned++;

    let html: string;
    try {
      html = Deno.readTextFileSync(`${dir}/${entry.name}`);
    } catch {
      continue;
    }

    const node = extractRecipeNode(html);
    if (!node) { res.noRecipe++; continue; }
    if (onlyChefJohn && !isChefJohn(node)) { res.skippedAuthor++; continue; }

    // The cache is named by allrecipes id; rebuild a canonical URL for it.
    const id = entry.name.replace(/\.html$/, "").replace(/^[a-z.]+-/, "");
    const url = `https://www.allrecipes.com/recipe/${id}/`;
    const recipe = buildRecipe(node, url);
    if (!recipe) { res.noRecipe++; continue; }

    db.upsertRecipe(recipe);
    res.imported++;
    progress(`+ ${recipe.title}`, "ok");
  }

  progress(
    `imported ${res.imported} of ${res.scanned} cached page(s)` +
      (onlyChefJohn ? ` (${res.skippedAuthor} by other authors)` : ""),
    "info",
  );
  return res;
}

/** Re-parse pantry-info's own HTML cache, e.g. after a parser change. */
export function reparseOwnCache(db: Db, progress: Progress): ImportResult {
  return importCachedPages(db, progress, pagesDir(), false);
}
