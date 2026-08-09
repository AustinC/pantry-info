/**
 * Scrape jobs shared by the TUI and the CLI.
 *
 * A keyword scrape is incremental and resumable: search results go into
 * `discovered`, and each run pulls the next N unscraped candidates. Running the
 * same keyword again therefore digs deeper rather than re-fetching what we have.
 */

import { Db } from "./db.ts";
import { Fetcher } from "./fetcher.ts";
import { pagesDir } from "./paths.ts";
import {
  allrecipesId,
  browseAuthorPage,
  fetchRecipe,
  searchChefJohn,
  type ScrapedRecipe,
} from "./scraper.ts";

export type Progress = (msg: string, kind?: "info" | "ok" | "warn" | "err") => void;

export interface ScrapeResult {
  added: number;
  skipped: number;
  failed: number;
  titles: string[];
}

function cachePage(source: string, sourceId: string, html: string): void {
  try {
    Deno.writeTextFileSync(`${pagesDir()}/${source}-${sourceId}.html`, html);
  } catch {
    // Cache is an optimisation; a write failure must not abort the scrape.
  }
}

/**
 * Scrape up to `count` new Chef John recipes matching `keyword`.
 * Reuses previously discovered candidates before issuing a new search.
 */
export async function scrapeKeyword(
  db: Db,
  keyword: string,
  count: number,
  progress: Progress,
  signal?: AbortSignal,
): Promise<ScrapeResult> {
  const fetcher = new Fetcher({ onLog: (m) => progress(m, "warn") });
  const result: ScrapeResult = { added: 0, skipped: 0, failed: 0, titles: [] };
  const kw = keyword.trim();
  if (!kw) {
    progress("enter a keyword first", "err");
    return result;
  }

  let pending = db.pendingForKeyword(kw, count);
  let found = 0;

  // Search when the local queue can't satisfy the request.
  if (pending.length < count) {
    progress(`searching allrecipes for "chef john ${kw}"…`);
    const hits = await searchChefJohn(fetcher, kw, signal);
    if (hits.length === 0) {
      progress("search returned nothing; falling back to the author page", "warn");
      const authorHits = await browseAuthorPage(fetcher, signal);
      found = db.addDiscovered(authorHits, kw);
    } else {
      found = db.addDiscovered(hits, kw);
      progress(`found ${hits.length} results (${found} new)`, "ok");
    }
    pending = db.pendingForKeyword(kw, count);
  } else {
    progress(`${pending.length} candidate(s) already queued for "${kw}"`);
  }

  if (pending.length === 0) {
    progress(`no new recipes left for "${kw}"`, "warn");
    db.recordKeywordRun(kw, found, 0);
    return result;
  }

  for (const cand of pending) {
    if (signal?.aborted) break;
    if (result.added >= count) break;

    // Already stored under a different URL spelling — don't spend a request.
    const candId = allrecipesId(cand.url);
    if (candId && db.hasSourceId("allrecipes.com", candId)) {
      db.markDiscoveredScraped(cand.url, "allrecipes.com", candId);
      continue;
    }
    progress(`fetching ${cand.slug || cand.url}…`);

    const { recipe, html, reason } = await fetchRecipe(fetcher, cand.url, {
      requireChefJohn: true,
      referer: "https://www.allrecipes.com/",
      signal,
    });

    if (html) cachePage("allrecipes.com", allrecipesId(cand.url) ?? cand.slug, html);

    if (!recipe) {
      if (reason === "not-chef-john") {
        db.markDiscoveredSkipped(cand.url, "not-chef-john");
        result.skipped++;
        progress(`  skipped (not Chef John)`, "warn");
      } else {
        db.markDiscoveredSkipped(cand.url, reason ?? "unknown");
        result.failed++;
        progress(`  failed (${reason})`, "err");
      }
      continue;
    }

    db.upsertRecipe(recipe);
    result.added++;
    result.titles.push(recipe.title);
    progress(`  + ${recipe.title} (${recipe.ingredients.length} ingredients)`, "ok");
  }

  db.recordKeywordRun(kw, found, result.added);

  // The queue may have been all non-Chef-John; tell the user rather than
  // silently reporting zero.
  if (result.added === 0 && (result.skipped > 0 || result.failed > 0)) {
    progress(
      `nothing stored — ${result.skipped} not Chef John, ${result.failed} failed. ` +
        `Try running again to go deeper.`,
      "warn",
    );
  }
  return result;
}

/** Download a single recipe from an arbitrary pasted URL. */
export async function scrapeUrl(
  db: Db,
  url: string,
  progress: Progress,
  signal?: AbortSignal,
): Promise<ScrapedRecipe | null> {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    progress("that doesn't look like a URL", "err");
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    progress("only http(s) URLs are supported", "err");
    return null;
  }
  if (db.hasUrl(trimmed)) {
    progress("already in the database", "warn");
    return null;
  }

  const fetcher = new Fetcher({ onLog: (m) => progress(m, "warn") });
  progress(`fetching ${parsed.hostname}…`);
  // No author gate here: a pasted URL is an explicit request for that page.
  const { recipe, html, reason } = await fetchRecipe(fetcher, trimmed, { signal });
  if (!recipe) {
    progress(
      reason === "no-jsonld"
        ? "no schema.org Recipe data found on that page"
        : `could not fetch that page (${reason})`,
      "err",
    );
    return null;
  }
  if (html) cachePage(recipe.source, recipe.sourceId, html);
  db.upsertRecipe(recipe);
  progress(`+ ${recipe.title} (${recipe.ingredients.length} ingredients)`, "ok");
  return recipe;
}
