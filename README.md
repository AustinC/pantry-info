# pantry-info

claude --resume 83d8bc43-2fbc-4941-81bc-037880a6bcfd

A keyword-driven recipe collector with a text UI, written in TypeScript for Deno.

You type a keyword. It fuzzy-searches your local SQLite recipe database. If what you
want isn't there yet, one keystroke scrapes a few more Chef John recipes for that
keyword and adds them. Over time the database grows along the axes you actually cook.

Ingredients are stored with the **amount separated from the ingredient name**, so a
future "what can I make with anchovies and olives?" search is a plain SQL join rather
than a text scrape.

## Quick start

```bash
cd pantry-info
deno task start
```

On first run with an empty database, pantry-info imports any recipe HTML already
cached by the companion Python scraper at `~/box/chefjohn/pages` — no network needed.

## The UI

```
pantry-info                    12 recipes · 168 ingredients · 20 queued · scrape 3
────────────────────────────────────────────────────────────────────────────────
❯ pasta▏
────────────────────────────────────────────────────────────────────────────────
❯ Chef John's Pasta Primavera                     ★4.4  45 min
  Chef John's BLT Pasta                           ★4.7  40 min
  Chef John's Creamy Mushroom Pasta               ★4.6  30 min
────────────────────────────────────────────────────────────────────────────────
 ↵ view · ^S scrape 3 · ^O url · ^N count · ^R reload · esc quit
```

| Key | Action |
| --- | --- |
| *type* | fuzzy-search the local database as you type |
| `↑` `↓` `PgUp` `PgDn` | move the selection |
| `Enter` | open the recipe (scroll with `↑↓` / `j` `k` / space) |
| `y` | *(in a recipe)* copy its URL to the clipboard |
| `Ctrl-S` | scrape N more Chef John recipes for the current keyword |
| `Ctrl-O` | paste a recipe URL to download directly |
| `Ctrl-N` | change how many recipes a scrape pulls (default 3) |
| `Ctrl-R` | reload the index |
| `Ctrl-W` / `Ctrl-U` | delete word / clear the query |
| `Esc` | back, or quit from the search screen |

### Clipboard

`y` in a recipe copies its URL. pantry-info tries `wl-copy`, `xclip`, `xsel` and
`pbcopy` first, and falls back to an OSC 52 escape sequence — which asks the terminal
itself to set the clipboard, so it needs no permissions and works over SSH. Inside
tmux the sequence is wrapped in a DCS passthrough; if it does nothing, your terminal
doesn't honour OSC 52, so install one of the helpers above.

The `start` task grants `--allow-run` for exactly those four binaries. Deno prints a
one-line notice for any that aren't installed; that's harmless. Permission is checked
with `querySync` before spawning, so a missing grant degrades to OSC 52 instead of
raising an interactive prompt over the UI.

### Search

Search is fzf-style: characters must appear in order, with contiguous runs and
word-boundary starts scoring highest, so `musroom` still finds *Creamy Mushroom
Pasta*. Multiple words are AND-ed. Titles rank above categories, which rank above
ingredients, which rank above descriptions.

## CLI

Everything the UI does is also scriptable:

```bash
deno task start                       # the TUI
deno run -A main.ts scrape pasta -n 5 # headless keyword scrape
deno run -A main.ts url <url>         # download one recipe
deno run -A main.ts import [dir]      # import cached HTML (offline)
deno run -A main.ts reparse           # re-parse own cache after a parser change
deno run -A main.ts stats             # what's in the database
deno run -A main.ts pantry anchovy olive   # preview of the on-hand search
```

## Browser extension (manual capture)

`extension/` is a Firefox add-on for pages you open yourself — an alternative to
programmatic scraping that sidesteps rate limiting entirely, since the page is
fetched by your own browser session.

It extracts the page's schema.org JSON-LD and hands it to pantry-info **unmodified**.
Everything downstream — ingredient splitting, dedupe, storage — runs through the same
`buildRecipe` path as the scraper, so a manual capture and an automated scrape produce
identical rows. Only the capture method differs.

### Installing

Firefox → `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick
`extension/manifest.json`. Temporary add-ons are removed when Firefox restarts; to
install permanently, sign it with `web-ext sign` or use Firefox Developer Edition with
`xpinstall.signatures.required=false`.

### Using it

Open a recipe, click the toolbar button, and choose one of:

| Action | What it does |
| --- | --- |
| **Send to pantry-info** | POSTs to a local receiver — one click, straight into the database |
| **Save .json** | Writes an export to `~/Downloads/pantry-info/<slug>.json` |
| **Copy JSON** | Puts the export on the clipboard |

For one-click sending, leave a receiver running:

```bash
deno task receive            # listens on 127.0.0.1:8787
```

The popup shows `connected` when it can reach it, `offline` otherwise — saving and
copying work either way. The port is configurable in the popup and remembered.

To import files instead:

```bash
deno run -A main.ts import-json ~/Downloads/pantry-info/          # a whole directory
deno run -A main.ts import-json ~/Downloads/pantry-info/pasta.json
pbpaste | deno run -A main.ts import-json -                       # from the clipboard
```

Exports include the page HTML, so `reparse` can rebuild captured recipes after a
parser change without re-visiting the site.

### Permissions and safety

The extension requests `activeTab` rather than access to any recipe site, so it can
only read a page at the moment you click its button, and it holds no standing
permission for allrecipes or anywhere else. Its only host permission is loopback.

The receiver binds to `127.0.0.1` only and is unauthenticated: any local process could
post a recipe to it. That is an acceptable trade for a personal tool whose only side
effect is adding rows to your own database — it never reads from or returns database
contents beyond a recipe count. Run it only while you're capturing.

### Export format

```jsonc
{
  "pantryInfo": 1,                    // envelope version, validated on import
  "url": "https://…",                 // canonical URL, so captures dedupe against scrapes
  "capturedAt": "2026-08-07T…",
  "jsonld": { "@type": "Recipe", … }, // verbatim from the page
  "html": "<html>…"                   // optional, enables reparse
}
```

Any site with schema.org Recipe markup works, not just allrecipes — and unlike the
keyword scraper, manual capture applies no Chef John author filter, since opening the
page is an explicit choice.

## How scraping works

allrecipes' own search is queried as `chef john <keyword>`. Results are a mix of Chef
John's recipes and similar ones by other cooks, so every candidate page is confirmed
against the `author` field in its schema.org JSON-LD before anything is stored.

Discovery and downloading are deliberately separated:

1. A search records **every** hit in the `discovered` table, tagged with the keyword.
2. Each scrape run downloads only the next N unscraped candidates.

So running `Ctrl-S` on "pasta" repeatedly digs deeper into the same result set rather
than re-fetching what you already have, and the queue survives across sessions.

Raw HTML is cached under the data directory, so the parser can be improved and the
whole database rebuilt with `reparse` — no re-fetching.

### Being a polite client

allrecipes fingerprints requests: a bare `User-Agent` gets a 403 interstitial, while a
complete, self-consistent Chrome header set is served normally. `src/fetcher.ts`
therefore sends matched UA + `sec-ch-ua` + `Sec-Fetch-*` profiles, and:

- issues requests **sequentially**, never concurrently
- waits a randomised 2.5–6 s between them
- backs off exponentially on 403/429/5xx, honouring `Retry-After`

Sustained scraping still trips a rate limit eventually; the scrape reports the failure
and stops rather than hammering. Wait a few minutes and run it again — the queue picks
up where it left off. Pulling a handful of recipes at a time is the intended usage.

## Ingredient storage

This is the part built for the deferred feature. Each line is split into columns:

| raw | quantity | unit | pack_size | name | name_norm | note |
| --- | --- | --- | --- | --- | --- | --- |
| `2.5 pounds ground chuck` | 2.5 | pound | — | ground chuck | chuck | — |
| `3 cloves garlic, coarsely chopped` | 3 | clove | — | garlic | garlic | coarsely chopped |
| `1 (14.5 ounce) can diced tomatoes, drained` | 1 | can | 14.5 | diced tomatoes | tomato | drained |
| `8 thick slices bacon` | 8 | slice | — | bacon | bacon | — |
| `1½ cups whole milk` | 1.5 | cup | — | whole milk | milk | — |

`name` keeps the descriptive form for display; `name_norm` is the lossy matching key —
lowercased, singularised, with prep and size words removed — so *anchovy fillets* and
*minced anchovies* both become `anchovy`. Section labels ("For the sauce:") are flagged
`is_heading` and excluded from ingredient matching.

The planned search already works from the CLI:

```
$ deno run -A main.ts pantry anchovy olive
 2/2  Puttanesca            (anchovy, kalamata olive)
 1/2  Olive Bread           (olive)
```

Wiring it into the UI is the next step; the schema and parser are in place.

## Layout

```
main.ts               CLI entry point and subcommands
extension/            Firefox add-on for manual capture
src/paths.ts          data directory resolution
src/db.ts             schema, upserts, discovery queue, ingredient queries
src/ingredients.ts    ingredient line parser
src/fuzzy.ts          fzf-style ranking
src/fetcher.ts        polite HTTP with header profiles and backoff
src/scraper.ts        JSON-LD extraction, search, URL canonicalisation
src/jobs.ts           keyword scrape and URL download
src/importer.ts       offline bootstrap from cached HTML
src/ingest.ts         browser-extension export format and import
src/receiver.ts       localhost endpoint for the extension
src/tui/term.ts       raw mode, key decoding, ANSI helpers
src/tui/app.ts        the UI state machine and renderer
tests/                unit tests (deno task test)
```

No third-party dependencies: SQLite comes from Deno's built-in `node:sqlite`, and the
UI is hand-rolled ANSI.

## Data location

`~/.local/share/pantry-info/` by default (`pantry.db` plus a `pages/` HTML cache).
Override with `$PANTRY_INFO_DIR` or `$XDG_DATA_HOME`.

## Relationship to the Python scraper

`~/box/scrape_chefjohn.py` crawls Chef John's catalogue broadly by cross-link discovery.
pantry-info instead grows *on demand* from keywords you search for, and adds structured
ingredients and a UI. It reads the Python scraper's HTML cache to bootstrap, but keeps
its own database and does not modify anything under `~/box`.
