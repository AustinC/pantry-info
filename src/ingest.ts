/**
 * Ingest for recipes captured by the browser extension.
 *
 * The extension sends the page's schema.org JSON-LD verbatim rather than a
 * pre-digested recipe, so everything downstream — ingredient parsing, dedupe,
 * storage — runs through exactly the same `buildRecipe` path as the scraper.
 * The capture method is the only thing that differs.
 */

import type { Db } from "./db.ts";
import { pagesDir } from "./paths.ts";
import { buildRecipe, normalizeUrl, type ScrapedRecipe } from "./scraper.ts";
import type { Progress } from "./jobs.ts";

/** Wire format written by the extension. `html` is optional but enables `reparse`. */
export interface ExportEnvelope {
  pantryInfo: number;
  url: string;
  capturedAt?: string;
  jsonld: unknown;
  html?: string;
}

export const ENVELOPE_VERSION = 1;

export class IngestError extends Error {}

/** Validate an untrusted payload before it reaches the database. */
export function parseEnvelope(raw: unknown): ExportEnvelope {
  if (typeof raw !== "object" || raw === null) throw new IngestError("payload is not an object");
  const e = raw as Record<string, unknown>;
  if (e.pantryInfo !== ENVELOPE_VERSION) {
    throw new IngestError(
      `unsupported envelope version ${String(e.pantryInfo)} (expected ${ENVELOPE_VERSION})`,
    );
  }
  if (typeof e.url !== "string" || !/^https?:\/\//.test(e.url)) {
    throw new IngestError("missing or invalid url");
  }
  if (e.jsonld === undefined || e.jsonld === null) throw new IngestError("missing jsonld");
  if (e.html !== undefined && typeof e.html !== "string") throw new IngestError("html must be a string");
  return {
    pantryInfo: ENVELOPE_VERSION,
    url: e.url,
    capturedAt: typeof e.capturedAt === "string" ? e.capturedAt : undefined,
    jsonld: e.jsonld,
    html: e.html,
  };
}

export interface IngestResult {
  recipe: ScrapedRecipe;
  /** True when this replaced an existing row rather than adding one. */
  updated: boolean;
}

/** Store a captured recipe. Throws IngestError if the payload isn't usable. */
export function ingestEnvelope(db: Db, env: ExportEnvelope): IngestResult {
  const url = normalizeUrl(env.url);
  const recipe = buildRecipe(env.jsonld, url);
  if (!recipe) throw new IngestError("the captured JSON-LD is not a usable Recipe");

  // Check both identities, exactly as upsertRecipe does — the same page can already
  // be stored under a different URL spelling (slugless, from the HTML cache).
  const updated = db.hasUrl(url) || db.hasSourceId(recipe.source, recipe.sourceId);

  if (env.html) {
    try {
      Deno.writeTextFileSync(`${pagesDir()}/${recipe.source}-${recipe.sourceId}.html`, env.html);
    } catch {
      // The HTML cache is an optimisation; never fail an import over it.
    }
  }
  db.upsertRecipe(recipe);
  return { recipe, updated };
}

/** Read one exported .json file and store it. */
export function ingestFile(db: Db, path: string, progress: Progress): ScrapedRecipe | null {
  let raw: unknown;
  try {
    raw = JSON.parse(Deno.readTextFileSync(path));
  } catch (e) {
    progress(`${path}: ${(e as Error).message}`, "err");
    return null;
  }
  try {
    const { recipe, updated } = ingestEnvelope(db, parseEnvelope(raw));
    progress(
      `${updated ? "updated" : "+"} ${recipe.title} (${recipe.ingredients.length} ingredients)`,
      "ok",
    );
    return recipe;
  } catch (e) {
    progress(`${path}: ${(e as Error).message}`, "err");
    return null;
  }
}

/** Drain stdin to a string (Deno 2 removed Deno.readAllSync). */
function readStdin(): string {
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(65536);
  let total = 0;
  while (true) {
    const n = Deno.stdin.readSync(buf);
    if (n === null || n === 0) break;
    chunks.push(buf.slice(0, n));
    total += n;
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(all);
}

/** Ingest a file, a directory of *.json exports, or `-` for stdin. */
export function ingestPaths(db: Db, paths: string[], progress: Progress): number {
  let count = 0;
  for (const p of paths) {
    if (p === "-") {
      const text = readStdin();
      try {
        const { recipe, updated } = ingestEnvelope(db, parseEnvelope(JSON.parse(text)));
        progress(
          `${updated ? "updated" : "+"} ${recipe.title} (${recipe.ingredients.length} ingredients)`,
          "ok",
        );
        count++;
      } catch (e) {
        progress(`stdin: ${(e as Error).message}`, "err");
      }
      continue;
    }

    let info: Deno.FileInfo;
    try {
      info = Deno.statSync(p);
    } catch {
      progress(`${p}: no such file`, "err");
      continue;
    }

    if (info.isDirectory) {
      const files = [...Deno.readDirSync(p)]
        .filter((e) => e.isFile && e.name.endsWith(".json"))
        .map((e) => `${p}/${e.name}`)
        .sort();
      if (files.length === 0) progress(`${p}: no .json exports found`, "warn");
      for (const f of files) if (ingestFile(db, f, progress)) count++;
    } else if (ingestFile(db, p, progress)) {
      count++;
    }
  }
  return count;
}
