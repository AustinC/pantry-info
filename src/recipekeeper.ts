/**
 * Import for RecipeKeeper's HTML export ("recipes.html").
 *
 * Each recipe is a `<div class="recipe-details">` block using schema.org
 * microdata attributes (itemprop) rather than JSON-LD, so it needs its own
 * regex-based extraction distinct from scraper.ts's JSON-LD path — but the
 * two converge on the same ScrapedRecipe shape and the same ingredient
 * parser, so a RecipeKeeper import and a web scrape store identically.
 */

import { decodeEntities, normalizeUrl } from "./scraper.ts";
import { parseIngredients } from "./ingredients.ts";
import type { ScrapedRecipe } from "./scraper.ts";

export interface RecipeKeeperEntry {
  recipe: ScrapedRecipe;
  /** The export's free-text "Notes" field, mapped to our own `note` column. */
  note: string | null;
}

const BLOCK_RE = /<div class="recipe-details">([\s\S]*?)(?=<div class="recipe-details">|$)/g;

function field(block: string, re: RegExp): string | null {
  const m = re.exec(block);
  return m ? decodeEntities(m[1]) : null;
}

/** Every `<p>...</p>` inside a container, entity-decoded, blanks dropped. */
function paragraphs(block: string, containerRe: RegExp): string[] {
  const container = containerRe.exec(block);
  if (!container) return [];
  return [...container[1].matchAll(/<p>([\s\S]*?)<\/p>/g)]
    .map((m) => decodeEntities(m[1]).trim())
    .filter(Boolean);
}

/** "PT0S" is the export's placeholder for "not set", not a real zero duration. */
function realDuration(iso: string | null): string | null {
  return iso && iso !== "PT0S" ? iso : null;
}

/** The renderer numbers steps itself; strip a source-baked "1. " to avoid "1. 1. …". */
function stripLeadingNumber(step: string): string {
  return step.replace(/^\s*\d+[.)]\s+/, "");
}

export function parseRecipeKeeperHtml(html: string): RecipeKeeperEntry[] {
  const entries: RecipeKeeperEntry[] = [];

  for (const blockMatch of html.matchAll(BLOCK_RE)) {
    const block = blockMatch[1];

    const recipeId = field(block, /<meta content="([^"]*)" itemprop="recipeId">/);
    const title = field(block, /<h2 itemprop="name">([\s\S]*?)<\/h2>/);
    if (!recipeId || !title) continue; // not a real recipe block

    const sourceHref = field(
      block,
      /<span itemprop="recipeSource"><a href="([^"]*)"/,
    );
    const servings = field(block, /<span itemprop="recipeYield">([^<]*)<\/span>/);
    const prepTime = realDuration(field(block, /<meta content="([^"]*)" itemprop="prepTime">/));
    const cookTime = realDuration(field(block, /<meta content="([^"]*)" itemprop="cookTime">/));

    const ingredientLines = paragraphs(
      block,
      /<div class="recipe-ingredients" itemprop="recipeIngredients">([\s\S]*?)<\/div>/,
    );
    const instructions = paragraphs(block, /<div itemprop="recipeDirections">([\s\S]*?)<\/div>/)
      .map(stripLeadingNumber);
    const notes = paragraphs(
      block,
      /<div class="recipe-notes" itemprop="recipeNotes">([\s\S]*?)<\/div>/,
    );

    const url = sourceHref
      ? normalizeUrl(sourceHref)
      : `https://recipekeeper.local/recipe/${recipeId}`;

    entries.push({
      recipe: {
        source: "recipekeeper",
        sourceId: recipeId,
        url,
        title: title.trim(),
        author: null,
        description: null,
        category: [],
        cuisine: [],
        keywords: [],
        prepTime,
        cookTime,
        totalTime: null,
        servings: servings?.trim() || null,
        rating: null,
        ratingCount: null,
        image: null,
        instructions,
        nutrition: null,
        ingredients: parseIngredients(ingredientLines),
      },
      note: notes.length ? notes.join("\n") : null,
    });
  }

  return entries;
}
