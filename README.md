# pantry-info

A terminal recipe manager. Your recipes are stored in a local SQLite
database. Type to fuzzy-search them, star favorites, add your own notes, or find
what you can cook with the ingredients you have.

<img width="800" alt="Screenshot_2026-11-06_22-29-40" src="https://github.com/user-attachments/assets/18d041ad-174a-4295-a642-175ae7cd1d24" />


Each ingredient's amount is stored separately from its name, so "what can I make
with anchovies and olives?" is a plain SQL join.

```bash
deno task start     # or ./run.sh
deno task test
```

## Searching

Results update as you type. The header shows database totals.

```
pantry-info                  48 recipes · 612 ingredients · 20 queued · scrape 3
─────────────────────────────────────────────────────────────────────────────────
❯ musroom pas▏
─────────────────────────────────────────────────────────────────────────────────
❯★ Chef John's Creamy Mushroom Pasta                                   30 min
   Mushroom Bolognese                                                  1 hr 10 min
   Pasta with Mushrooms and Peas                                       25 min
─────────────────────────────────────────────────────────────────────────────────
 ↵ view · ^T star · ^G ingredients · ^S scrape 3 · ^O url · ^E receive · ^N count
```

Matching is fzf-style: the query's letters only need to appear in order, so
`musroom` still finds "Mushroom". With several words, every word must match, but
each can match a different field. A hit in a higher-weighted field ranks higher:

| Field | Weight | | Field | Weight |
| --- | --- | --- | --- | --- |
| title | 1.0 | | ingredient names | 0.45 |
| your note | 0.6 | | site keywords | 0.4 |
| category, cuisine | 0.55 | | description | 0.22 |

Instructions are not searched. With an empty query, starred recipes are listed
first, then the highest rated. Stars don't change ranked search results.

| Key | Action |
| --- | --- |
| *type* · `^W` · `^U` | edit the query (delete a word / clear it) |
| `↑` `↓` `PgUp` `PgDn` | move the selection |
| `Enter` | open the recipe |
| `^T` | star or unstar |
| `^G` | switch to [ingredient search](#ingredient-search) |
| `^E` | start/stop the [browser extension](#browser-extension) receiver |
| `^O` | download a recipe from a URL |
| `^S` · `^N` | [scrape](#scraping-allrecipes) N recipes for the query · set N (default 3) |
| `^R` | reload the index |
| `Esc` | quit |

## Viewing a recipe

```
★ Chef John's Creamy Mushroom Pasta
Chef John  ·  30 min  ·  serves 4  ·  Main Dishes
https://www.allrecipes.com/recipe/284761/

Ingredients
  12 ounces         rigatoni
  2 tablespoons     butter
  1 pound           cremini mushrooms, sliced
  3 cloves          garlic, minced
  1 cup             heavy cream
                    salt and freshly ground black pepper, to taste

Note
  ▏ Double the garlic. Good with a splash of white wine before the cream.

Instructions
   1. Bring a large pot of salted water to a boil. Cook the rigatoni until
      just tender, about 11 minutes. Reserve 1 cup of the pasta water.
   2. Melt butter in a large skillet over medium-high heat…
─────────────────────────────────────────────────────────────────────────────────
 ↑↓/jk scroll · y copy url · ^A note · ^R rename · ^X cooking mode · esc back · 0%
```

| Key | Action |
| --- | --- |
| `↑` `↓` `j` `k` | scroll a line (`PgUp` `PgDn` space scroll a page) |
| `y` | copy the URL (tries `wl-copy`, `xclip`, `xsel` and `pbcopy`, then falls back to OSC 52, which also works over SSH and in tmux) |
| `^A` | add or edit a personal note, shown above the instructions |
| `^R` | rename the recipe |
| `^X` | cooking mode: stops the screen from sleeping for up to 90 minutes, using `systemd-inhibit` (Linux only) |
| `Esc` `q` | back to the list (also turns off cooking mode) |

## Ingredient search

`Ctrl-G` switches to building a list of ingredients you have. Recipes are ranked
by the share of their ingredients that you have, so a short recipe you can make
completely ranks above a long one you're mostly missing. If a recipe is missing
four ingredients or fewer, they're listed next to its title.

```
pantry-info                  48 recipes · 612 ingredients · 20 queued · scrape 3
─────────────────────────────────────────────────────────────────────────────────
 Have (4): garlic, olive oil, anchovy, spaghetti
─────────────────────────────────────────────────────────────────────────────────
❯ oliv▏
─────────────────────────────────────────────────────────────────────────────────
❯✓ olive oil                                                              (31)
   kalamata olive                                                          (3)
   green olive                                                             (2)
Recipes by % of ingredients on hand:
  100%  Spaghetti Aglio e Olio                                          4/4
   67%  Pasta Puttanesca  needs kalamata olive, capers, tomato          6/9
   40%  Caesar Salad  needs romaine, parmesan, egg                      2/5
─────────────────────────────────────────────────────────────────────────────────
 ↵ add/remove · ↑↓ move · Tab → recipes · esc back
```

Type to filter ingredient names (amounts are ignored), and press `Enter` to add or
remove the highlighted one. `Tab` moves to the recipe list, where `Enter` opens a
recipe. The "have" list is saved, so it acts as a record of your actual pantry.

From the command line, `pantry` does a looser version that matches substrings
of ingredient names:

```
$ deno task pantry anchovy olive
Recipes using anchovy, olive:

 2/2  Pasta Puttanesca  (anchovy, kalamata olive)
 1/2  Olive Bread  (olive)
```

## Adding recipes

All of these store recipes the same way: ingredients go through the same parser,
and a recipe that's already in the database (matched by URL) is updated rather
than duplicated.

| Source | How |
| --- | --- |
| [Browser extension](#browser-extension) | one click on any recipe page you have open |
| Recipe Keeper | `deno run -A main.ts import-recipekeeper recipes.html ["Title" ...]` |
| A single URL | `Ctrl-O`, or `deno run -A main.ts url <url>` |
| [allrecipes scraping](#scraping-allrecipes) | `Ctrl-S`, or `deno task scrape <keyword> -n 5` |

**Recipe Keeper** reads the app's `recipes.html` export, including its notes. Give
one or more titles to import only those recipes.

**A single URL** works on any site whose pages include schema.org Recipe data.

### Browser extension

`extension/` is a Firefox add-on that captures the recipe on the page you're
viewing. Your browser loads the page, so there are no rate limits to deal with. It
works on any site with schema.org Recipe data, and passes the page's JSON-LD
through unchanged.

**Install:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary
Add-on**, and select `extension/manifest.json`. A temporary add-on is removed when
Firefox restarts. To keep it, sign it with `web-ext sign`.

**Use:** click the toolbar button on a recipe page, then choose one of:

- **Send to pantry-info:** posts the recipe to a local receiver. Start it with
  `Ctrl-E` in the UI (the header shows `◉ :8787` while it runs) or with
  `deno task receive [-p PORT]`. The popup says `connected` or `offline`.
- **Save .json:** writes `~/Downloads/pantry-info/<slug>.json`. Import it with
  `deno task import-json <file|dir>`.
- **Copy JSON:** copies the export to the clipboard. Import it with
  `pbpaste | deno task import-json -`.

```jsonc
{
  "pantryInfo": 1,                    // envelope version
  "url": "https://…",                 // canonical, so re-captures update in place
  "capturedAt": "2026-08-07T…",
  "jsonld": { "@type": "Recipe", … }, // verbatim from the page
  "html": "<html>…"                   // optional, enables reparse
}
```

The extension uses `activeTab`, so it can only read a page at the moment you click
the button. Its only host permission is for `127.0.0.1`. The receiver listens on
`127.0.0.1` only and has no authentication. Any local process can add a recipe
through it, but it never returns database contents, only a recipe count. Leave it
running only while you're capturing.

### Scraping allrecipes

`Ctrl-S` searches allrecipes for `chef john <query>`, adds every result to a queue,
and downloads the next N. It keeps only recipes whose schema.org `author` is Chef
John. Running it again on the same keyword continues through the queue.

The fetcher sends one request at a time with a full set of Chrome headers, and
waits a random 2.5–6 s between requests. It backs off on 403, 429 and 5xx,
respecting `Retry-After`. If scraping still hits a rate limit, the run stops. Try
again a few minutes later.

### Other commands

```bash
deno task stats                 # counts, plus scrape history per keyword
deno run -A main.ts reparse     # rebuild every recipe from the HTML cache after a parser change
deno task import [dir]          # import cached HTML (default ~/box/chefjohn/pages)
```

If the database is empty when the UI starts, it first imports any cached HTML from
`~/box/chefjohn/pages`.

## Ingredient storage

Each ingredient line is split into columns:

| raw | qty | unit | pack | name | name_norm | note |
| --- | --- | --- | --- | --- | --- | --- |
| `2.5 pounds ground chuck` | 2.5 | pound | | ground chuck | chuck | |
| `3 cloves garlic, coarsely chopped` | 3 | clove | | garlic | garlic | coarsely chopped |
| `1 (14.5 ounce) can diced tomatoes, drained` | 1 | can | 14.5 oz | diced tomatoes | tomato | drained |
| `1½ cups whole milk` | 1.5 | cup | | whole milk | milk | |

`name` is the full name for display. `name_norm` is the key used for matching:
lowercase and singular, with prep and size words removed, so "anchovy fillets" and
"minced anchovies" both become `anchovy`. Section labels like "For the sauce:" are
flagged `is_heading` and left out of matching.

## Layout

```
main.ts               CLI entry point and subcommands
src/db.ts             schema, upserts, discovery queue, ingredient queries
src/ingredients.ts    ingredient line parser
src/fuzzy.ts          fzf-style ranking
src/recipekeeper.ts   Recipe Keeper HTML export import
src/ingest.ts         browser extension export format
src/receiver.ts       localhost endpoint for the extension
src/scraper.ts        JSON-LD extraction, allrecipes search, URL canonicalisation
src/fetcher.ts        HTTP with header profiles, delays, backoff
src/jobs.ts           keyword scrape and single-URL download
src/importer.ts       import from cached HTML, reparse
src/paths.ts          data directory resolution
src/tui/              UI: app state and rendering, terminal I/O, clipboard, cooking mode
extension/            Firefox add-on
tests/                unit tests
```

Data is stored in `~/.local/share/pantry-info/`: `pantry.db` and a `pages/` cache
of raw HTML. Set `$PANTRY_INFO_DIR` or `$XDG_DATA_HOME` to change the location.
