#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
/**
 * pantry-info — a keyword-driven recipe collector with a text UI.
 *
 *   pantry-info                       launch the TUI
 *   pantry-info import [dir]          bootstrap from the Python scraper's HTML cache
 *   pantry-info scrape <kw> [-n N]    headless keyword scrape
 *   pantry-info url <url>             download one recipe by URL
 *   pantry-info pantry <ing>...       (preview) rank recipes by ingredients on hand
 *   pantry-info stats                 database summary
 */

import { Db } from "./src/db.ts";
import { App } from "./src/tui/app.ts";
import { importCachedPages, reparseOwnCache } from "./src/importer.ts";
import { scrapeKeyword, scrapeUrl } from "./src/jobs.ts";
import { ingestPaths } from "./src/ingest.ts";
import { parseRecipeKeeperHtml } from "./src/recipekeeper.ts";
import { DEFAULT_PORT, serveReceiver } from "./src/receiver.ts";
import { dataDir, legacyChefJohnDir } from "./src/paths.ts";

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  blue: "\x1b[38;5;75m", green: "\x1b[38;5;114m",
  yellow: "\x1b[38;5;179m", red: "\x1b[38;5;203m",
};

const log = (msg: string, kind: string = "info") => {
  const color = kind === "ok" ? C.green : kind === "warn" ? C.yellow : kind === "err" ? C.red : C.dim;
  console.log(`${color}${msg}${C.reset}`);
};

function usage(): void {
  console.log(`
${C.bold}${C.blue}pantry-info${C.reset} — keyword-driven recipe collector

${C.bold}USAGE${C.reset}
  pantry-info                      launch the text UI
  pantry-info import [dir]         import cached recipe HTML (default: ${legacyChefJohnDir()}/pages)
  pantry-info reparse              re-parse pantry-info's own HTML cache
  pantry-info scrape <keyword> [-n N]
  pantry-info url <url>
  pantry-info import-json <file|dir|-> ...   import browser-extension exports
  pantry-info receive [-p PORT]              accept captures from the extension
  pantry-info pantry <ingredient>...   preview of the planned on-hand search
  pantry-info stats

${C.bold}DATA${C.reset}
  ${dataDir()}
  Override with $PANTRY_INFO_DIR.
`);
}

function parseCount(args: string[], fallback: number): number {
  const i = args.findIndex((a) => a === "-n" || a === "--count");
  if (i === -1) return fallback;
  const n = parseInt(args[i + 1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
  const argv = [...Deno.args];
  const cmd = argv[0];

  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    usage();
    return;
  }

  const db = new Db();
  try {
    switch (cmd) {
      case undefined: {
        if (!Deno.stdin.isTerminal()) {
          console.error("pantry-info needs an interactive terminal; try `pantry-info --help`");
          Deno.exit(1);
        }
        // First run with nothing stored: offer the free offline bootstrap.
        if (db.stats().recipes === 0) {
          log("empty database — importing any cached pages from the Python scraper…");
          importCachedPages(db, log);
        }
        await new App(db).run();
        return;
      }

      case "import": {
        const dir = argv[1];
        importCachedPages(db, log, dir ?? `${legacyChefJohnDir()}/pages`);
        return;
      }

      case "reparse": {
        reparseOwnCache(db, log);
        return;
      }

      case "scrape": {
        const words = argv.slice(1).filter((a, i, arr) =>
          !a.startsWith("-") && arr[i - 1] !== "-n" && arr[i - 1] !== "--count"
        );
        const keyword = words.join(" ");
        if (!keyword) {
          console.error("usage: pantry-info scrape <keyword> [-n N]");
          Deno.exit(1);
        }
        const n = parseCount(argv, 3);
        const r = await scrapeKeyword(db, keyword, n, log);
        log(`\n${r.added} added, ${r.skipped} skipped, ${r.failed} failed`, r.added ? "ok" : "warn");
        return;
      }

      case "url": {
        const url = argv[1];
        if (!url) {
          console.error("usage: pantry-info url <url>");
          Deno.exit(1);
        }
        await scrapeUrl(db, url, log);
        return;
      }

      case "pantry": {
        const items = argv.slice(1);
        if (items.length === 0) {
          console.error("usage: pantry-info pantry <ingredient>...");
          Deno.exit(1);
        }
        const rows = db.byIngredients(items);
        if (rows.length === 0) {
          log("no recipes use those ingredients yet", "warn");
          return;
        }
        console.log(
          `${C.dim}Recipes using ${items.join(", ")}:${C.reset}\n`,
        );
        for (const r of rows) {
          console.log(
            `${C.green}${String(r.matched).padStart(2)}/${items.length}${C.reset}  ` +
              `${r.title}  ${C.dim}(${r.matches})${C.reset}`,
          );
        }
        return;
      }

      case "import-json": {
        const paths = argv.slice(1);
        if (paths.length === 0) {
          console.error("usage: pantry-info import-json <file|dir|-> ...");
          Deno.exit(1);
        }
        const n = ingestPaths(db, paths, log);
        log(`\n${n} recipe(s) imported`, n ? "ok" : "warn");
        return;
      }

      case "import-recipekeeper": {
        const file = argv[1];
        const titles = argv.slice(2);
        if (!file) {
          console.error(
            "usage: pantry-info import-recipekeeper <recipes.html> [title ...]\n" +
              "  (omit titles to import every recipe in the file)",
          );
          Deno.exit(1);
        }
        let html: string;
        try {
          html = Deno.readTextFileSync(file);
        } catch (e) {
          console.error(`could not read ${file}: ${(e as Error).message}`);
          Deno.exit(1);
        }
        const entries = parseRecipeKeeperHtml(html);
        const wanted = titles.length ? new Set(titles.map((t) => t.toLowerCase())) : null;
        let count = 0;
        for (const { recipe, note } of entries) {
          if (wanted && !wanted.has(recipe.title.toLowerCase())) continue;
          const id = db.upsertRecipe(recipe);
          if (note) db.setNote(id, note);
          log(`+ ${recipe.title} (${recipe.ingredients.length} ingredients)`, "ok");
          count++;
        }
        if (wanted && count < wanted.size) {
          const found = new Set(entries.map((e) => e.recipe.title.toLowerCase()));
          for (const t of titles) {
            if (!found.has(t.toLowerCase())) log(`  not found: "${t}"`, "warn");
          }
        }
        log(`\n${count} recipe(s) imported`, count ? "ok" : "warn");
        return;
      }

      case "receive": {
        const port = parseInt(
          argv[argv.findIndex((a) => a === "-p" || a === "--port") + 1] ?? "",
          10,
        );
        const controller = new AbortController();
        let stored = 0;
        const server = serveReceiver(db, log, {
          port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
          signal: controller.signal,
          onStored: () => stored++,
        });
        const stop = () => {
          log(`\nstopping — ${stored} recipe(s) received this session`);
          controller.abort();
        };
        Deno.addSignalListener("SIGINT", stop);
        Deno.addSignalListener("SIGTERM", stop);
        await server.finished;
        return;
      }

      case "stats": {
        const s = db.stats();
        console.log(`${C.bold}pantry-info${C.reset}  ${C.dim}${dataDir()}${C.reset}`);
        console.log(`  recipes      ${s.recipes}`);
        console.log(`  ingredients  ${s.ingredients}`);
        console.log(`  discovered   ${s.discovered} (${s.pending} not yet scraped)`);
        const hist = db.keywordHistory();
        if (hist.length) {
          console.log(`\n${C.bold}keywords${C.reset}`);
          for (const h of hist) {
            console.log(`  ${h.keyword.padEnd(20)} ${C.dim}${h.scraped} scraped · ${h.last_run.slice(0, 10)}${C.reset}`);
          }
        }
        return;
      }

      default:
        console.error(`unknown command: ${cmd}`);
        usage();
        Deno.exit(1);
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  await main();
}
