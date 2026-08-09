/**
 * Discovery and extraction for allrecipes (and any site with schema.org/Recipe JSON-LD).
 *
 * Keyword discovery uses allrecipes' own search, queried as "chef john <keyword>",
 * then confirms authorship from each recipe page's JSON-LD before storing — the
 * search results are a mix of Chef John's recipes and similar ones from other cooks.
 */

import type { Fetcher } from "./fetcher.ts";
import { parseIngredients, type ParsedIngredient } from "./ingredients.ts";

export const AUTHOR_URL = "https://www.allrecipes.com/author/chef-john/";

/**
 * Both allrecipes URL shapes, capturing the numeric id. The slug is optional so
 * that a slugless URL (as rebuilt from the HTML cache) still yields its real id
 * rather than falling through to a content hash.
 */
const RECIPE_URL_RE =
  /https:\/\/www\.allrecipes\.com\/(?:recipe\/(\d+)(?:\/[a-z0-9-]*)?|[a-z0-9-]*recipe-(\d+))/g;

const LDJSON_RE = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;

export interface ScrapedRecipe {
  source: string;
  sourceId: string;
  url: string;
  title: string;
  author: string | null;
  description: string | null;
  category: string[];
  cuisine: string[];
  keywords: string[];
  prepTime: string | null;
  cookTime: string | null;
  totalTime: string | null;
  servings: string | null;
  rating: number | null;
  ratingCount: number | null;
  image: string | null;
  instructions: string[];
  nutrition: Record<string, unknown> | null;
  ingredients: ParsedIngredient[];
}

export interface DiscoveredRecipe {
  url: string;
  sourceId: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function allrecipesId(url: string): string | null {
  const re = new RegExp(RECIPE_URL_RE.source);
  const m = re.exec(url);
  return m ? (m[1] ?? m[2]) : null;
}

/**
 * One canonical spelling per page, so a URL discovered in search results and the
 * same URL taken from a page's JSON-LD compare equal. Drops query/fragment and
 * enforces a trailing slash.
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    return u.toString();
  } catch {
    return url;
  }
}

/** Pull every distinct allrecipes recipe link out of a page, in document order. */
export function extractRecipeLinks(html: string): DiscoveredRecipe[] {
  const seen = new Set<string>();
  const out: DiscoveredRecipe[] = [];
  for (const m of html.matchAll(RECIPE_URL_RE)) {
    const id = m[1] ?? m[2];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const slug = m[0].split("/").filter(Boolean).pop() ?? "";
    out.push({ url: normalizeUrl(m[0]), sourceId: id, slug: /^\d+$/.test(slug) ? "" : slug });
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON-LD extraction
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
function findRecipeNode(obj: any): any | null {
  if (Array.isArray(obj)) {
    for (const o of obj) {
      const r = findRecipeNode(o);
      if (r) return r;
    }
    return null;
  }
  if (obj && typeof obj === "object") {
    const t = obj["@type"];
    const types = Array.isArray(t) ? t : [t];
    if (types.includes("Recipe")) return obj;
    if (obj["@graph"]) return findRecipeNode(obj["@graph"]);
  }
  return null;
}

// deno-lint-ignore no-explicit-any
export function extractRecipeNode(html: string): any | null {
  for (const m of html.matchAll(LDJSON_RE)) {
    const block = m[1].trim();
    let data: unknown;
    try {
      data = JSON.parse(block);
    } catch {
      try {
        data = JSON.parse(block.replace(/;\s*$/, ""));
      } catch {
        continue;
      }
    }
    const node = findRecipeNode(data);
    if (node) return node;
  }
  return null;
}

// deno-lint-ignore no-explicit-any
function asList(v: any): any[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// deno-lint-ignore no-explicit-any
function names(v: any): string[] {
  const out: string[] = [];
  for (const item of asList(v)) {
    if (typeof item === "string") out.push(item);
    else if (item && typeof item === "object" && typeof item.name === "string") out.push(item.name);
  }
  return out.map(decodeEntities).filter(Boolean);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .trim();
}

// deno-lint-ignore no-explicit-any
function parseInstructions(node: any): string[] {
  const steps: string[] = [];
  const walk = (items: unknown[]) => {
    for (const item of items) {
      if (typeof item === "string") steps.push(decodeEntities(stripTags(item)));
      // deno-lint-ignore no-explicit-any
      else if (item && typeof item === "object") {
        const o = item as any;
        if (o["@type"] === "HowToSection") walk(asList(o.itemListElement));
        else if (typeof o.text === "string") steps.push(decodeEntities(stripTags(o.text)));
      }
    }
  };
  walk(asList(node.recipeInstructions));
  return steps.filter((s) => s.length > 0);
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function isChefJohn(node: unknown): boolean {
  // deno-lint-ignore no-explicit-any
  for (const n of names((node as any)?.author)) {
    const low = n.toLowerCase();
    if (low.includes("chef john") || low.includes("mitzewich")) return true;
  }
  return false;
}

/** Turn a schema.org Recipe node into our storage shape. */
export function buildRecipe(node: unknown, url: string): ScrapedRecipe | null {
  // deno-lint-ignore no-explicit-any
  const n = node as any;
  const title = decodeEntities(String(n?.name ?? "")).trim();
  if (!title) return null;

  const host = safeHost(url);
  const sourceId = allrecipesId(url) ?? hashId(url);

  let rating: number | null = null;
  let ratingCount: number | null = null;
  const agg = n.aggregateRating;
  if (agg && typeof agg === "object") {
    const rv = Number(agg.ratingValue);
    rating = Number.isFinite(rv) ? rv : null;
    const rc = Number(agg.ratingCount ?? agg.reviewCount);
    ratingCount = Number.isFinite(rc) ? rc : null;
  }

  const kwRaw = n.keywords;
  const keywords = Array.isArray(kwRaw)
    ? kwRaw.map(String)
    : typeof kwRaw === "string"
    ? kwRaw.split(",").map((k) => k.trim()).filter(Boolean)
    : [];

  const image = firstImage(n.image);

  return {
    source: host,
    sourceId,
    url,
    title,
    author: names(n.author)[0] ?? null,
    description: n.description ? decodeEntities(stripTags(String(n.description))) : null,
    category: names(n.recipeCategory),
    cuisine: names(n.recipeCuisine),
    keywords,
    prepTime: n.prepTime ?? null,
    cookTime: n.cookTime ?? null,
    totalTime: n.totalTime ?? null,
    servings: n.recipeYield ? String(asList(n.recipeYield)[0]) : null,
    rating,
    ratingCount,
    image,
    instructions: parseInstructions(n),
    nutrition: n.nutrition && typeof n.nutrition === "object" ? n.nutrition : null,
    ingredients: parseIngredients(
      asList(n.recipeIngredient).filter((x) => typeof x === "string").map(decodeEntities),
    ),
  };
}

// deno-lint-ignore no-explicit-any
function firstImage(v: any): string | null {
  for (const item of asList(v)) {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      if (typeof item.url === "string") return item.url;
      if (Array.isArray(item.url) && typeof item.url[0] === "string") return item.url[0];
    }
  }
  return null;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/** Stable id for non-allrecipes URLs (FNV-1a). */
function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// ---------------------------------------------------------------------------
// Network operations
// ---------------------------------------------------------------------------

/** Search allrecipes for Chef John recipes matching a keyword. */
export async function searchChefJohn(
  fetcher: Fetcher,
  keyword: string,
  signal?: AbortSignal,
): Promise<DiscoveredRecipe[]> {
  const q = encodeURIComponent(`chef john ${keyword}`.trim());
  const html = await fetcher.get(`https://www.allrecipes.com/search?q=${q}`, undefined, signal);
  if (!html) return [];
  return extractRecipeLinks(html);
}

/** Fall back to the author page when search yields nothing new. */
export async function browseAuthorPage(
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<DiscoveredRecipe[]> {
  const html = await fetcher.get(AUTHOR_URL, undefined, signal);
  return html ? extractRecipeLinks(html) : [];
}

export interface FetchRecipeResult {
  recipe: ScrapedRecipe | null;
  html: string | null;
  reason?: "fetch-failed" | "no-jsonld" | "not-chef-john";
}

/** Fetch one recipe page and parse it. `requireChefJohn` gates keyword scrapes. */
export async function fetchRecipe(
  fetcher: Fetcher,
  url: string,
  opts: { requireChefJohn?: boolean; referer?: string; signal?: AbortSignal } = {},
): Promise<FetchRecipeResult> {
  const html = await fetcher.get(url, opts.referer, opts.signal);
  if (!html) return { recipe: null, html: null, reason: "fetch-failed" };
  const node = extractRecipeNode(html);
  if (!node) return { recipe: null, html, reason: "no-jsonld" };
  if (opts.requireChefJohn && !isChefJohn(node)) {
    return { recipe: null, html, reason: "not-chef-john" };
  }
  const recipe = buildRecipe(node, normalizeUrl(canonicalUrl(url, node)));
  return recipe ? { recipe, html } : { recipe: null, html, reason: "no-jsonld" };
}

/** Prefer the page's own canonical URL so cached ids stay stable. */
// deno-lint-ignore no-explicit-any
function canonicalUrl(url: string, node: any): string {
  const id = node?.["@id"] ?? node?.url ?? node?.mainEntityOfPage?.["@id"];
  if (typeof id === "string" && id.startsWith("http") && allrecipesId(id)) return id;
  return url;
}

/** ISO-8601 duration ("PT1H30M") to a compact human string ("1 hr 30 min"). */
export function humanDuration(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(iso);
  if (!m) return iso;
  const [d, h, min] = [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  const parts: string[] = [];
  if (d) parts.push(`${d} day${d > 1 ? "s" : ""}`);
  if (h) parts.push(`${h} hr`);
  if (min) parts.push(`${min} min`);
  return parts.length ? parts.join(" ") : null;
}
