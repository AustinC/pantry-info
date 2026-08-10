/**
 * The text UI.
 *
 * One screen, four modes:
 *   search  — type a keyword, fuzzy-ranked local results update as you type
 *   detail  — scrollable view of one recipe
 *   scrape  — streaming log of a keyword scrape or URL download
 *   prompt  — single-line input (paste a URL / set the scrape count)
 *
 * Every frame is built as a string and written in one syscall, which keeps
 * redraws flicker-free without a diffing layer.
 */

import { Db, type IngredientRow, type RecipeRow, type SearchRow } from "../db.ts";
import { rankStrings, search as fuzzySearch, type Match, type StringMatch } from "../fuzzy.ts";
import { formatAmount } from "../ingredients.ts";
import { humanDuration } from "../scraper.ts";
import { scrapeKeyword, scrapeUrl } from "../jobs.ts";
import { DEFAULT_PORT, serveReceiver } from "../receiver.ts";
import { copyToClipboard } from "./clipboard.ts";
import { DIGIT_HEIGHT, renderStepNumber, stepNumberWidth } from "./bigNumber.ts";
import { type CookingModeHandle, startCookingMode } from "./cookingMode.ts";
import {
  ansi,
  clearScreen,
  enterAlt,
  exitAlt,
  highlight,
  type Key,
  keyStream,
  padEnd,
  size,
  theme,
  truncate,
  wrap,
  write,
} from "./term.ts";

type Mode = "search" | "detail" | "scrape" | "prompt" | "note" | "ingredients";

interface NoteEdit {
  recipeId: number;
  title: string;
  text: string;
}

interface LogLine {
  text: string;
  kind: "info" | "ok" | "warn" | "err";
}

interface PromptState {
  label: string;
  value: string;
  hint: string;
  onSubmit: (value: string) => void;
}

interface IngredientResult {
  id: number;
  title: string;
  matched: number;
  total: number;
  missing: string[];
}

export class App {
  #db: Db;
  #index: SearchRow[] = [];
  #matches: Match[] = [];
  #query = "";
  #sel = 0;
  #listTop = 0;
  #mode: Mode = "search";
  #scrapeCount = 3;
  #status = "";

  #detail: { recipe: RecipeRow; ingredients: IngredientRow[]; scroll: number } | null = null;
  /** Transient message in the detail footer (e.g. "url copied"). */
  #detailStatus = "";
  /** Which screen to return to when the detail view closes. */
  #detailReturnTo: "search" | "ingredients" = "search";
  /** Scoped to whichever recipe is open; leaving the recipe always ends it. */
  #cooking: { handle: CookingModeHandle; title: string } | null = null;
  #log: LogLine[] = [];
  #logScroll = 0;
  #busy = false;
  #abort: AbortController | null = null;
  #prompt: PromptState | null = null;
  #note: NoteEdit | null = null;
  #quit = false;

  /** Local endpoint for the browser extension, toggled with Ctrl-E. */
  #receiver: { controller: AbortController; port: number; received: number } | null = null;
  #receiverPort = DEFAULT_PORT;

  // -- ingredient search (Ctrl-G) --------------------------------------------
  // Not Ctrl-I: every terminal sends that as byte 0x09, identical to Tab, so
  // the two can never be told apart — binding Ctrl-I here would be silently
  // unreachable.
  // All distinct ingredient names in the database, most-used first; the picker
  // fuzzy-searches this list rather than free text.
  #ingredientNames: string[] = [];
  #ingredientCounts: Map<string, number> = new Map();
  #ingQuery = "";
  #ingCandidates: StringMatch[] = [];
  #ingSel = 0;
  #ingCandTop = 0;
  // The "have" list is written through to the database on every toggle, so it
  // survives quitting and relaunching; loaded once here as the source of truth.
  #included: string[] = [];
  #includedSet: Set<string> = new Set();
  #ingResults: IngredientResult[] = [];
  #ingResultSel = 0;
  #ingResultTop = 0;
  #ingFocus: "candidates" | "results" = "candidates";

  constructor(db: Db) {
    this.#db = db;
    this.#included = db.getHaveIngredients();
    this.#includedSet = new Set(this.#included);
  }

  async run(): Promise<void> {
    this.#reloadIndex();
    Deno.stdin.setRaw(true);
    enterAlt();
    const restore = async () => {
      try { Deno.stdin.setRaw(false); } catch { /* already restored */ }
      // Leave no listener behind holding the event loop open.
      this.#receiver?.controller.abort();
      this.#receiver = null;
      // Awaited deliberately: once this process exits, nothing else will ever
      // stop systemd-inhibit — an unawaited kill here could leave the monitor
      // unable to sleep for up to 90 minutes with no app left to fix it.
      if (this.#cooking) {
        const c = this.#cooking;
        this.#cooking = null;
        await c.handle.stop();
      }
      exitAlt();
    };
    // Restore the terminal even if the process is interrupted.
    const onSignal = async () => { await restore(); Deno.exit(0); };
    Deno.addSignalListener("SIGINT", onSignal);
    Deno.addSignalListener("SIGTERM", onSignal);

    try {
      this.#render();
      for await (const key of keyStream()) {
        this.#handleKey(key);
        if (this.#quit) break;
        this.#render();
      }
    } finally {
      Deno.removeSignalListener("SIGINT", onSignal);
      Deno.removeSignalListener("SIGTERM", onSignal);
      await restore();
    }
  }

  // -- data ----------------------------------------------------------------

  #reloadIndex(): void {
    this.#index = this.#db.searchIndex();
    this.#refilter();
  }

  #refilter(): void {
    this.#matches = fuzzySearch(this.#index, this.#query);
    this.#sel = Math.min(this.#sel, Math.max(0, this.#matches.length - 1));
    this.#listTop = 0;
  }

  // -- input ---------------------------------------------------------------

  #handleKey(k: Key): void {
    if (this.#mode === "note") return this.#handleNoteKey(k);
    if (this.#mode === "ingredients") return this.#handleIngredientKey(k);
    if (this.#mode === "prompt") return this.#handlePromptKey(k);
    if (this.#mode === "detail") return this.#handleDetailKey(k);
    if (this.#mode === "scrape") return this.#handleScrapeKey(k);
    return this.#handleSearchKey(k);
  }

  #handleSearchKey(k: Key): void {
    if (k.ctrl && k.name === "c") { this.#quit = true; return; }
    if (k.name === "escape") { this.#quit = true; return; }

    if (k.ctrl) {
      switch (k.name) {
        case "s": return this.#startKeywordScrape();
        case "o": return this.#askUrl();
        case "n": return this.#askCount();
        case "e": return this.#toggleReceiver();
        case "t": return this.#toggleStar();
        case "g": return this.#enterIngredientMode();
        case "r":
          this.#reloadIndex();
          this.#status = "index reloaded";
          return;
        case "u":
          this.#query = "";
          this.#refilter();
          return;
        case "w":
          this.#query = this.#query.replace(/\s*\S+\s*$/, "");
          this.#refilter();
          return;
        case "p": return this.#move(-1);
      }
      return;
    }

    switch (k.name) {
      case "up": return this.#move(-1);
      case "down": return this.#move(1);
      case "pageup": return this.#move(-10);
      case "pagedown": return this.#move(10);
      case "home": this.#sel = 0; return;
      case "end": this.#sel = Math.max(0, this.#matches.length - 1); return;
      case "backspace":
        this.#query = this.#query.slice(0, -1);
        this.#refilter();
        return;
      case "enter": return this.#openSelected();
    }

    if (k.ch && k.ch >= " ") {
      this.#query += k.ch;
      this.#refilter();
    }
  }

  #handleDetailKey(k: Key): void {
    if ((k.ctrl && k.name === "c")) { this.#quit = true; return; }
    if (k.name === "escape" || k.name === "backspace" || (k.ch === "q")) {
      this.#mode = this.#detailReturnTo;
      this.#detail = null;
      this.#detailStatus = "";
      this.#leaveCookingMode();
      return;
    }
    if (!this.#detail) return;

    if (k.ch === "y" || (k.ctrl && k.name === "y")) return this.#copyUrl();
    if (k.ctrl && k.name === "a") return this.#editNote();
    if (k.ctrl && k.name === "b") return this.#toggleCookingMode();
    this.#detailStatus = ""; // any other key clears the last message

    const step = (n: number) => {
      this.#detail!.scroll = Math.max(0, this.#detail!.scroll + n);
    };
    switch (k.name) {
      case "up": return step(-1);
      case "down": return step(1);
      case "pageup": return step(-(size().rows - 6));
      case "pagedown": return step(size().rows - 6);
      case "home": this.#detail.scroll = 0; return;
    }
    if (k.ch === "j") step(1);
    else if (k.ch === "k") step(-1);
    else if (k.ch === " ") step(size().rows - 6);
  }

  #handleScrapeKey(k: Key): void {
    if (k.ctrl && k.name === "c") {
      if (this.#busy) { this.#abort?.abort(); this.#pushLog("aborting…", "warn"); return; }
      this.#quit = true;
      return;
    }
    if (k.name === "escape") {
      if (this.#busy) { this.#abort?.abort(); this.#pushLog("aborting…", "warn"); return; }
      this.#mode = "search";
      this.#reloadIndex();
      return;
    }
    if (k.name === "enter" && !this.#busy) {
      this.#mode = "search";
      this.#reloadIndex();
      return;
    }
    if (k.name === "up") this.#logScroll = Math.max(0, this.#logScroll - 1);
    if (k.name === "down") this.#logScroll++;
  }

  #handlePromptKey(k: Key): void {
    const p = this.#prompt!;
    if (k.ctrl && k.name === "c") { this.#mode = "search"; this.#prompt = null; return; }
    if (k.name === "escape") { this.#mode = "search"; this.#prompt = null; return; }
    if (k.name === "enter") {
      const v = p.value;
      this.#prompt = null;
      this.#mode = "search";
      p.onSubmit(v);
      return;
    }
    if (k.name === "backspace") { p.value = p.value.slice(0, -1); return; }
    if (k.ctrl && k.name === "u") { p.value = ""; return; }
    if (k.ch && k.ch >= " ") p.value += k.ch;
  }

  /**
   * Note editor input. Editing happens at the end of the buffer — there is no
   * cursor to move — which keeps this simple and is enough for short notes.
   */
  #handleNoteKey(k: Key): void {
    const n = this.#note!;
    if (k.ctrl && k.name === "c") { this.#closeNote(false); return; }
    if (k.name === "escape") { this.#closeNote(false); return; }
    if (k.ctrl && k.name === "s") { this.#closeNote(true); return; }

    if (k.ctrl && k.name === "u") { n.text = ""; return; }
    if (k.ctrl && k.name === "w") {
      n.text = n.text.replace(/\s*\S+\s*$/, "");
      return;
    }
    if (k.name === "backspace") { n.text = n.text.slice(0, -1); return; }
    if (k.name === "enter") { n.text += "\n"; return; }
    if (k.ch && k.ch >= " ") n.text += k.ch;
  }

  /** Open the note editor for the recipe currently open in detail view. */
  #editNote(): void {
    if (!this.#detail) return;
    const { id, title, note } = this.#detail.recipe;
    this.#note = { recipeId: id, title, text: note ?? "" };
    this.#mode = "note";
  }

  #closeNote(save: boolean): void {
    const n = this.#note;
    this.#note = null;
    this.#mode = "detail";
    if (!n) return;

    if (save) {
      this.#db.setNote(n.recipeId, n.text);
      this.#reloadIndex();
      this.#detailStatus = n.text.trim() ? `note saved for ${n.title}` : `note cleared for ${n.title}`;
      // Re-read so the saved note shows immediately.
      const recipe = this.#db.getRecipe(n.recipeId);
      if (recipe && this.#detail) this.#detail.recipe = recipe;
    } else {
      this.#detailStatus = "note discarded";
    }
  }

  #move(delta: number): void {
    if (this.#matches.length === 0) return;
    this.#sel = Math.max(0, Math.min(this.#matches.length - 1, this.#sel + delta));
  }

  // -- actions -------------------------------------------------------------

  #openSelected(): void {
    const m = this.#matches[this.#sel];
    if (!m) return;
    this.#openRecipe(m.row.id, "search");
  }

  #openRecipe(id: number, returnTo: "search" | "ingredients"): void {
    const recipe = this.#db.getRecipe(id);
    if (!recipe) return;
    this.#detail = { recipe, ingredients: this.#db.getIngredients(recipe.id), scroll: 0 };
    this.#detailReturnTo = returnTo;
    this.#mode = "detail";
  }

  /**
   * Star or unstar the highlighted recipe.
   *
   * Starring re-sorts the list under the cursor, so the selection is re-anchored
   * to the same recipe afterwards rather than to the same row number.
   */
  #toggleStar(): void {
    const match = this.#matches[this.#sel];
    if (!match) return;
    const id = match.row.id;
    const nowStarred = this.#db.toggleStar(id);

    this.#reloadIndex();
    const moved = this.#matches.findIndex((m) => m.row.id === id);
    if (moved >= 0) this.#sel = moved;

    this.#status = `${nowStarred ? "starred" : "unstarred"} ${match.row.title}`;
  }

  // -- ingredient search -----------------------------------------------------

  /**
   * Enter ingredient-search mode. Loads the current distinct ingredient list
   * fresh each time (cheap, and keeps it in sync with anything just scraped),
   * but keeps the user's picks from a previous visit this session.
   */
  #enterIngredientMode(): void {
    this.#ingredientCounts = new Map();
    this.#ingredientNames = this.#db.distinctIngredientNames().map((r) => {
      this.#ingredientCounts.set(r.nameNorm, r.count);
      return r.nameNorm;
    });
    this.#ingFocus = "candidates";
    this.#refilterIngredients();
    this.#recomputeIngredientResults();
    this.#mode = "ingredients";
  }

  #refilterIngredients(): void {
    if (!this.#ingQuery.trim()) {
      // No query: browse by popularity rather than an arbitrary/alphabetical order.
      this.#ingCandidates = this.#ingredientNames.map((text) => ({ text, score: 0, hits: [] }));
    } else {
      this.#ingCandidates = rankStrings(this.#ingredientNames, this.#ingQuery);
    }
    this.#ingSel = Math.min(this.#ingSel, Math.max(0, this.#ingCandidates.length - 1));
    this.#ingCandTop = 0;
  }

  #recomputeIngredientResults(): void {
    this.#ingResults = this.#included.length
      ? this.#db.recipesByIngredientNames(this.#included)
      : [];
    this.#ingResultSel = Math.min(this.#ingResultSel, Math.max(0, this.#ingResults.length - 1));
    this.#ingResultTop = 0;
  }

  /** Add or remove the highlighted candidate from the "have" list. */
  #toggleIncludedCandidate(): void {
    const c = this.#ingCandidates[this.#ingSel];
    if (!c) return;
    if (this.#includedSet.has(c.text)) {
      this.#includedSet.delete(c.text);
      this.#included = this.#included.filter((n) => n !== c.text);
      this.#db.removeHaveIngredient(c.text);
    } else {
      this.#includedSet.add(c.text);
      this.#included.push(c.text);
      this.#db.addHaveIngredient(c.text);
    }
    this.#recomputeIngredientResults();
  }

  #openIngredientResult(): void {
    const r = this.#ingResults[this.#ingResultSel];
    if (!r) return;
    this.#openRecipe(r.id, "ingredients");
  }

  #handleIngredientKey(k: Key): void {
    if (k.ctrl && k.name === "c") { this.#quit = true; return; }
    if (k.name === "escape") { this.#mode = "search"; return; }

    if (k.name === "tab") {
      if (this.#ingFocus === "candidates") {
        if (this.#ingResults.length) this.#ingFocus = "results";
      } else {
        this.#ingFocus = "candidates";
      }
      return;
    }

    if (this.#ingFocus === "results") {
      const max = this.#ingResults.length - 1;
      switch (k.name) {
        case "up": this.#ingResultSel = Math.max(0, this.#ingResultSel - 1); return;
        case "down": this.#ingResultSel = Math.min(max, this.#ingResultSel + 1); return;
        case "pageup": this.#ingResultSel = Math.max(0, this.#ingResultSel - 10); return;
        case "pagedown": this.#ingResultSel = Math.min(max, this.#ingResultSel + 10); return;
        case "home": this.#ingResultSel = 0; return;
        case "end": this.#ingResultSel = Math.max(0, max); return;
        case "enter": return this.#openIngredientResult();
      }
      return; // typing is ignored while browsing results
    }

    // focus === "candidates"
    const max = this.#ingCandidates.length - 1;
    switch (k.name) {
      case "up": this.#ingSel = Math.max(0, this.#ingSel - 1); return;
      case "down": this.#ingSel = Math.min(max, this.#ingSel + 1); return;
      case "pageup": this.#ingSel = Math.max(0, this.#ingSel - 10); return;
      case "pagedown": this.#ingSel = Math.min(max, this.#ingSel + 10); return;
      case "home": this.#ingSel = 0; return;
      case "end": this.#ingSel = Math.max(0, max); return;
      case "enter": return this.#toggleIncludedCandidate();
      case "backspace":
        if (this.#ingQuery) {
          this.#ingQuery = this.#ingQuery.slice(0, -1);
          this.#refilterIngredients();
        }
        return;
    }

    if (k.ctrl && k.name === "u") {
      this.#ingQuery = "";
      this.#refilterIngredients();
      return;
    }
    if (k.ctrl && k.name === "w") {
      this.#ingQuery = this.#ingQuery.replace(/\s*\S+\s*$/, "");
      this.#refilterIngredients();
      return;
    }

    if (k.ch && k.ch >= " ") {
      this.#ingQuery += k.ch;
      this.#refilterIngredients();
    }
  }

  /**
   * Start or stop the extension receiver.
   *
   * Its progress messages go to the status line rather than stdout — writing to
   * the console here would punch holes in the rendered frame.
   */
  #toggleReceiver(): void {
    if (this.#receiver) {
      this.#receiver.controller.abort();
      const { port, received } = this.#receiver;
      this.#receiver = null;
      this.#status = `receiver stopped (:${port}, ${received} received)`;
      return;
    }

    const controller = new AbortController();
    const state = { controller, port: this.#receiverPort, received: 0 };
    try {
      serveReceiver(this.#db, (msg, kind) => {
        // Surface failures; successful captures are reported via onStored below.
        if (kind === "err") this.#status = msg;
        this.#render();
      }, {
        port: this.#receiverPort,
        signal: controller.signal,
        onStored: (title) => {
          state.received++;
          this.#status = `received: ${title}`;
          this.#reloadIndex();
          this.#render();
        },
      });
    } catch (e) {
      const msg = (e as Error).message;
      this.#status = msg.includes("Address in use")
        ? `port ${this.#receiverPort} is already in use — is a receiver already running?`
        : `could not start receiver: ${msg}`;
      return;
    }

    this.#receiver = state;
    this.#status = `receiver listening on 127.0.0.1:${state.port}`;
  }

  /** Copy the open recipe's URL, reporting the outcome in the detail footer. */
  #copyUrl(): void {
    const url = this.#detail?.recipe.url;
    if (!url) return;
    this.#detailStatus = "copying…";
    copyToClipboard(url, (s) => write(s))
      .then((r) => { this.#detailStatus = `url copied (${r.via})`; })
      .catch((e) => { this.#detailStatus = `copy failed: ${(e as Error).message}`; })
      .finally(() => { if (this.#mode === "detail") this.#render(); });
  }

  /** Start or stop cooking mode for the open recipe. */
  #toggleCookingMode(): void {
    if (!this.#detail) return;

    if (this.#cooking) {
      const c = this.#cooking;
      this.#cooking = null; // reflect the change immediately; stop() finishes in the background
      this.#detailStatus = "cooking mode off — monitor sleep restored";
      c.handle.stop().catch(() => {});
      return;
    }

    const title = this.#detail.recipe.title;
    this.#detailStatus = "starting cooking mode…";
    const result = startCookingMode(`pantry-info: cooking "${title}"`, () => this.#onCookingExpired());
    if (!result.ok) {
      this.#detailStatus = `cooking mode unavailable — ${result.reason}`;
      return;
    }
    this.#cooking = { handle: result.handle, title };
    this.#detailStatus = "cooking mode on — monitor sleep disabled for up to 90 min";
  }

  /** The 90-minute cap elapsed without an explicit toggle-off. */
  #onCookingExpired(): void {
    if (!this.#cooking) return;
    this.#cooking = null;
    if (this.#mode === "detail") {
      this.#detailStatus = "cooking mode auto-expired after 90 min — monitor sleep restored";
    }
    this.#render();
  }

  /** Cooking mode is scoped to the open recipe — leaving it always ends it. */
  #leaveCookingMode(): void {
    if (!this.#cooking) return;
    const c = this.#cooking;
    this.#cooking = null;
    c.handle.stop().catch(() => {});
  }

  #askUrl(): void {
    this.#prompt = {
      label: "Recipe URL",
      value: "",
      hint: "paste a link to any recipe page with schema.org data · Esc cancels",
      onSubmit: (v) => { if (v.trim()) this.#startUrlScrape(v.trim()); },
    };
    this.#mode = "prompt";
  }

  #askCount(): void {
    this.#prompt = {
      label: `Recipes per scrape (now ${this.#scrapeCount})`,
      value: "",
      hint: "how many new recipes to pull each time · Esc cancels",
      onSubmit: (v) => {
        const n = parseInt(v.trim(), 10);
        if (Number.isFinite(n) && n > 0) {
          this.#scrapeCount = Math.min(n, 100);
          this.#status = `scrape count set to ${this.#scrapeCount}`;
        } else if (v.trim()) {
          this.#status = "count must be a positive number";
        }
      },
    };
    this.#mode = "prompt";
  }

  #pushLog(text: string, kind: LogLine["kind"] = "info"): void {
    this.#log.push({ text, kind });
    this.#logScroll = Number.MAX_SAFE_INTEGER; // stick to the bottom
    if (this.#mode === "scrape") this.#render();
  }

  #startKeywordScrape(): void {
    if (this.#busy) return;
    const kw = this.#query.trim();
    if (!kw) { this.#status = "type a keyword first, then Ctrl-S"; return; }
    this.#log = [];
    this.#logScroll = 0;
    this.#mode = "scrape";
    this.#busy = true;
    this.#abort = new AbortController();
    this.#pushLog(`scraping up to ${this.#scrapeCount} new recipe(s) for "${kw}"`, "info");

    scrapeKeyword(this.#db, kw, this.#scrapeCount, (m, kind) => this.#pushLog(m, kind ?? "info"), this.#abort.signal)
      .then((r) => {
        this.#pushLog(
          `done — ${r.added} added, ${r.skipped} skipped, ${r.failed} failed`,
          r.added > 0 ? "ok" : "warn",
        );
      })
      .catch((e) => this.#pushLog(`error: ${(e as Error).message}`, "err"))
      .finally(() => {
        this.#busy = false;
        this.#reloadIndex();
        this.#pushLog("press Enter or Esc to return", "info");
      });
  }

  #startUrlScrape(url: string): void {
    if (this.#busy) return;
    this.#log = [];
    this.#logScroll = 0;
    this.#mode = "scrape";
    this.#busy = true;
    this.#abort = new AbortController();
    this.#pushLog(`downloading ${url}`, "info");

    scrapeUrl(this.#db, url, (m, kind) => this.#pushLog(m, kind ?? "info"), this.#abort.signal)
      .catch((e) => this.#pushLog(`error: ${(e as Error).message}`, "err"))
      .finally(() => {
        this.#busy = false;
        this.#reloadIndex();
        this.#pushLog("press Enter or Esc to return", "info");
      });
  }

  // -- rendering -----------------------------------------------------------

  #render(): void {
    const { cols, rows } = size();
    const body = this.#mode === "note"
      ? this.#renderNote(cols, rows)
      : this.#mode === "ingredients"
      ? this.#renderIngredients(cols, rows)
      : this.#mode === "detail"
      ? this.#renderDetail(cols, rows)
      : this.#mode === "scrape"
      ? this.#renderScrape(cols, rows)
      : this.#mode === "prompt"
      ? this.#renderPrompt(cols, rows)
      : this.#renderSearch(cols, rows);
    write(clearScreen() + body.join("\r\n"));
  }

  #header(cols: number): string {
    const s = this.#db.stats();
    // A visible indicator matters here: the receiver keeps running in the
    // background, so there must be no doubt about whether it is live.
    const recv = this.#receiver
      ? `${theme.good}◉ :${this.#receiver.port}${ansi.reset}${theme.muted} · ${ansi.reset}`
      : "";
    const recvPlain = this.#receiver ? `◉ :${this.#receiver.port} · ` : "";

    const left = `${ansi.bold}${theme.accent}pantry-info${ansi.reset}`;
    const statsPlain = `${s.recipes} recipes · ${s.ingredients} ingredients · ` +
      `${s.pending} queued · scrape ${this.#scrapeCount}`;
    const right = recv + theme.muted + statsPlain + ansi.reset;
    const gap = Math.max(1, cols - "pantry-info".length - recvPlain.length - statsPlain.length - 1);
    return left + " ".repeat(gap) + right;
  }

  #renderSearch(cols: number, rows: number): string[] {
    const out: string[] = [];
    out.push(this.#header(cols));
    out.push(theme.faint + "─".repeat(cols) + ansi.reset);

    const caret = `${theme.accent}❯${ansi.reset} `;
    out.push(caret + this.#query + `${theme.accent}▏${ansi.reset}`);
    out.push(theme.faint + "─".repeat(cols) + ansi.reset);

    const footerLines = 2;
    const listHeight = Math.max(3, rows - out.length - footerLines - 1);

    // Keep the selection inside the visible window.
    if (this.#sel < this.#listTop) this.#listTop = this.#sel;
    if (this.#sel >= this.#listTop + listHeight) this.#listTop = this.#sel - listHeight + 1;

    if (this.#matches.length === 0) {
      const msg = this.#index.length === 0
        ? "Database is empty. Type a keyword and press Ctrl-S to scrape, or Ctrl-O to paste a URL."
        : `No local match for "${this.#query}". Press Ctrl-S to scrape Chef John recipes for it.`;
      for (const line of wrap(msg, cols - 4)) out.push("  " + theme.muted + line + ansi.reset);
      for (let i = out.length; i < rows - footerLines - 1; i++) out.push("");
    } else {
      const visible = this.#matches.slice(this.#listTop, this.#listTop + listHeight);
      visible.forEach((m, i) => {
        const idx = this.#listTop + i;
        const selected = idx === this.#sel;
        out.push(this.#renderRow(m, selected, cols));
      });
      for (let i = visible.length; i < listHeight; i++) out.push("");
    }

    out.push(theme.faint + "─".repeat(cols) + ansi.reset);
    out.push(this.#footer(cols));
    return out.slice(0, rows);
  }

  #renderRow(m: Match, selected: boolean, cols: number): string {
    const meta = humanDuration(m.row.total_time) ?? "";
    const metaW = 12;
    const gutterW = 4; // cursor + star + space
    const titleW = Math.max(10, cols - metaW - gutterW - 2);

    const base = selected ? theme.selBg + ansi.bold : "";
    const title = truncate(m.row.title, titleW);
    const hits = m.titleHits.filter((h) => h < title.length);

    const cursor = selected ? `${theme.accentAlt}❯${ansi.reset}${base}` : " ";
    const star = m.row.starred
      ? `${theme.accentAlt}★${ansi.reset}${base}`
      : " ";
    const line = `${cursor}${star} ` + highlight(title, hits, base) +
      base + " ".repeat(Math.max(1, titleW - title.length + 1)) +
      (selected ? theme.accentAlt : theme.muted) + padEnd(meta, metaW) + ansi.reset;
    return selected ? theme.selBg + padEnd(line, cols) + ansi.reset : line;
  }

  #footer(cols: number): string {
    if (this.#status) {
      const s = ` ${theme.warn}${this.#status}${ansi.reset}`;
      this.#status = "";
      return s;
    }
    const keys = [
      ["↵", "view"],
      ["^T", "star"],
      ["^G", "ingredients"],
      ["^S", `scrape ${this.#scrapeCount}`],
      ["^O", "url"],
      ["^E", this.#receiver ? "stop recv" : "receive"],
      ["^N", "count"],
      ["^R", "reload"],
      ["esc", "quit"],
    ];
    // Drop hints from the right rather than letting the line wrap.
    let budget = cols - 1;
    const shown: string[][] = [];
    for (const pair of keys) {
      const width = pair[0].length + 1 + pair[1].length + 3;
      if (width > budget) break;
      budget -= width;
      shown.push(pair);
    }
    return " " + shown
      .map(([k, v]) => `${theme.accent}${k}${ansi.reset} ${theme.muted}${v}${ansi.reset}`)
      .join(`${theme.faint} · ${ansi.reset}`);
  }

  #renderIngredients(cols: number, rows: number): string[] {
    const out: string[] = [];
    const rule = theme.faint + "─".repeat(cols) + ansi.reset;

    out.push(this.#header(cols));
    out.push(rule);

    const chipsText = this.#included.length
      ? this.#included.join(", ")
      : "(none yet — search and press ↵ to add)";
    out.push(
      ` ${theme.muted}Have (${this.#included.length}):${ansi.reset} ` +
        `${theme.good}${truncate(chipsText, cols - 14)}${ansi.reset}`,
    );
    out.push(rule);

    out.push(`${theme.accent}❯${ansi.reset} ${this.#ingQuery}${theme.accent}▏${ansi.reset}`);
    out.push(rule);

    // Split the remaining space between the candidate picker and the ranked
    // recipe results, favouring results since that is the point of the screen.
    const footerLines = 2;
    const labelLines = 1;
    const remaining = Math.max(6, rows - out.length - footerLines - labelLines);
    const candH = Math.max(3, Math.min(7, Math.floor(remaining * 0.4)));
    const resultsH = Math.max(3, remaining - candH);

    if (this.#ingSel < this.#ingCandTop) this.#ingCandTop = this.#ingSel;
    if (this.#ingSel >= this.#ingCandTop + candH) this.#ingCandTop = this.#ingSel - candH + 1;

    if (this.#ingCandidates.length === 0) {
      out.push(`  ${theme.muted}no ingredients match "${this.#ingQuery}"${ansi.reset}`);
      for (let i = 1; i < candH; i++) out.push("");
    } else {
      const visible = this.#ingCandidates.slice(this.#ingCandTop, this.#ingCandTop + candH);
      visible.forEach((c, i) => {
        out.push(this.#renderIngredientCandidate(c, this.#ingCandTop + i === this.#ingSel, cols));
      });
      for (let i = visible.length; i < candH; i++) out.push("");
    }

    out.push(
      `${theme.muted}Recipes by % of ingredients on hand` +
        (this.#ingFocus === "results" ? ` ${theme.accentAlt}(focused)${theme.muted}` : "") +
        `:${ansi.reset}`,
    );

    if (this.#ingResultSel < this.#ingResultTop) this.#ingResultTop = this.#ingResultSel;
    if (this.#ingResultSel >= this.#ingResultTop + resultsH) {
      this.#ingResultTop = this.#ingResultSel - resultsH + 1;
    }

    if (this.#ingResults.length === 0) {
      const msg = this.#included.length
        ? "no recipes use any of these"
        : "pick ingredients above to see matches";
      out.push(`  ${theme.muted}${msg}${ansi.reset}`);
      for (let i = 1; i < resultsH; i++) out.push("");
    } else {
      const visible = this.#ingResults.slice(this.#ingResultTop, this.#ingResultTop + resultsH);
      visible.forEach((r, i) => {
        out.push(
          this.#renderIngredientResult(r, this.#ingResultTop + i === this.#ingResultSel, cols),
        );
      });
      for (let i = visible.length; i < resultsH; i++) out.push("");
    }

    out.push(rule);
    const hint = this.#ingFocus === "candidates"
      ? "↵ add/remove · ↑↓ move · Tab → recipes · esc back"
      : "↵ view recipe · ↑↓ move · Tab → ingredients · esc back";
    out.push(` ${theme.muted}${truncate(hint, cols - 2)}${ansi.reset}`);

    return out.slice(0, rows);
  }

  #renderIngredientCandidate(c: StringMatch, selected: boolean, cols: number): string {
    const selectedOnly = selected && this.#ingFocus === "candidates";
    const base = selectedOnly ? theme.selBg + ansi.bold : "";
    const cursor = selectedOnly ? `${theme.accentAlt}❯${ansi.reset}${base}` : " ";
    const included = this.#includedSet.has(c.text);
    const mark = included ? `${theme.good}✓${ansi.reset}${base}` : " ";
    const count = this.#ingredientCounts.get(c.text) ?? 0;
    const countText = `(${count})`;
    const nameW = Math.max(6, cols - 4 - countText.length - 2);
    const name = truncate(c.text, nameW);
    const hits = c.hits.filter((h) => h < name.length);

    const line = `${cursor}${mark} ` + highlight(name, hits, base) +
      base + " ".repeat(Math.max(1, nameW - name.length + 1)) +
      theme.faint + countText + ansi.reset;
    return selectedOnly ? theme.selBg + padEnd(line, cols) + ansi.reset : line;
  }

  #renderIngredientResult(r: IngredientResult, selected: boolean, cols: number): string {
    const selectedOnly = selected && this.#ingFocus === "results";
    const base = selectedOnly ? theme.selBg + ansi.bold : "";
    const cursor = selectedOnly ? `${theme.accentAlt}❯${ansi.reset}${base}` : " ";
    const pct = Math.round((r.matched / r.total) * 100);
    const pctText = `${String(pct).padStart(3)}%`;
    const fraction = `${r.matched}/${r.total}`;
    const fracW = 8;

    // A short, actionable gap list earns its place next to the title; a long
    // one is just noise, so it's only shown up to a handful of items.
    const missingText = r.missing.length > 0 && r.missing.length <= 4
      ? `needs ${r.missing.join(", ")}`
      : "";

    const prefixW = 2 + pctText.length + 2; // cursor + space + pct + 2 spaces
    const avail = Math.max(10, cols - prefixW - fracW - 1);

    let title = r.title;
    let missing = missingText;
    if (missing && title.length + 2 + missing.length > avail) {
      // The title always gets at least 60% of the space; the gap list takes
      // whatever's left, or is dropped entirely if that isn't enough to read.
      const titleW = Math.min(title.length, Math.max(8, Math.floor(avail * 0.6)));
      title = truncate(title, titleW);
      const missingW = avail - title.length - 2;
      missing = missingW >= 6 ? truncate(missing, missingW) : "";
    } else {
      title = truncate(title, avail);
    }

    const usedW = title.length + (missing ? missing.length + 2 : 0);
    const pad = " ".repeat(Math.max(1, avail - usedW + 1));

    const line = `${cursor} ${theme.accentAlt}${pctText}${ansi.reset}${base}  ${title}` +
      (missing ? `  ${theme.warn}${missing}${ansi.reset}${base}` : "") +
      base + pad + theme.faint + padEnd(fraction, fracW) + ansi.reset;
    return selectedOnly ? theme.selBg + padEnd(line, cols) + ansi.reset : line;
  }

  /**
   * A step whose text wraps to 2+ lines gets its number rendered as a small
   * ASCII-art glyph instead of "NN." — legible at a glance while your hands are
   * busy cooking. Short steps keep the plain "NN." prefix; there's no point
   * spending 5 rows on a number next to one line of text.
   */
  #renderScaledStep(num: number, minDigits: number, wrapped: string[]): string[] {
    const glyphRows = renderStepNumber(num, minDigits);
    const glyphW = stepNumberWidth(minDigits);
    const bodyH = Math.max(DIGIT_HEIGHT, wrapped.length);
    const out: string[] = [];
    for (let row = 0; row < bodyH; row++) {
      const glyph = row < DIGIT_HEIGHT ? glyphRows[row] : " ".repeat(glyphW);
      const text = row < wrapped.length ? wrapped[row] : "";
      out.push(`  ${theme.accentAlt}${glyph}${ansi.reset}  ${text}`);
    }
    return out;
  }

  #renderDetail(cols: number, rows: number): string[] {
    const d = this.#detail!;
    const width = Math.min(cols - 2, 100);
    const lines: string[] = [];
    const r = d.recipe;

    const star = r.starred ? `${theme.accentAlt}★ ${ansi.reset}` : "";
    lines.push(`${star}${ansi.bold}${theme.accentAlt}${r.title}${ansi.reset}`);
    const meta: string[] = [];
    if (r.author) meta.push(r.author);
    const t = humanDuration(r.total_time);
    if (t) meta.push(t);
    if (r.servings) meta.push(`serves ${r.servings}`);
    if (r.category) meta.push(r.category);
    if (meta.length) lines.push(theme.muted + meta.join("  ·  ") + ansi.reset);
    lines.push(theme.faint + r.url + ansi.reset);
    lines.push("");

    if (r.description) {
      for (const l of wrap(r.description, width)) lines.push(theme.muted + l + ansi.reset);
      lines.push("");
    }

    lines.push(`${ansi.bold}${theme.accent}Ingredients${ansi.reset}`);
    for (const ing of d.ingredients) {
      if (ing.is_heading) {
        lines.push("");
        lines.push(`  ${ansi.bold}${ing.name}${ansi.reset}`);
        continue;
      }
      const amt = formatAmount({
        raw: ing.raw,
        quantity: ing.quantity,
        quantityMax: ing.quantity_max,
        unit: ing.unit,
        packSize: ing.pack_size,
        packUnit: ing.pack_unit,
        name: ing.name,
        nameNorm: ing.name_norm,
        note: ing.note,
        optional: !!ing.optional,
        isHeading: false,
      });
      const note = ing.note ? `${theme.faint}, ${ing.note}${ansi.reset}` : "";
      const amtCol = amt ? `${theme.accentAlt}${padEnd(amt, 18)}${ansi.reset}` : " ".repeat(18);
      lines.push(`  ${amtCol}${ing.name}${note}`);
    }
    lines.push("");

    // The user's own note sits between the ingredients and the method, where
    // it is visible while cooking without scrolling past the steps.
    if (r.note) {
      lines.push(`${ansi.bold}${theme.accentAlt}Note${ansi.reset}`);
      for (const l of wrap(r.note, width - 4)) {
        lines.push(`  ${theme.accentAlt}▏${ansi.reset} ${l}`);
      }
      lines.push("");
    }

    const steps: string[] = JSON.parse(r.instructions || "[]");
    if (steps.length) {
      lines.push(`${ansi.bold}${theme.accent}Instructions${ansi.reset}`);
      // Scaled step numbers (see #renderScaledStep / bigNumber.ts) are built
      // but disabled for now — revisit later rather than wire back in here.
      steps.forEach((s, i) => {
        const wrapped = wrap(s, width - 5);
        wrapped.forEach((w, j) => {
          lines.push(
            j === 0
              ? `  ${theme.accentAlt}${String(i + 1).padStart(2)}.${ansi.reset} ${w}`
              : `      ${w}`,
          );
        });
        lines.push("");
      });
    }

    // Viewport
    const viewH = rows - 3;
    const maxScroll = Math.max(0, lines.length - viewH);
    d.scroll = Math.min(d.scroll, maxScroll);
    const view = lines.slice(d.scroll, d.scroll + viewH);
    while (view.length < viewH) view.push("");

    const pct = maxScroll === 0 ? "all" : `${Math.round((d.scroll / maxScroll) * 100)}%`;
    const sep = `${theme.faint} · ${ansi.reset}`;
    const foot = ` ${theme.accent}↑↓/jk${ansi.reset} ${theme.muted}scroll${ansi.reset}` +
      sep + `${theme.accent}y${ansi.reset} ${theme.muted}copy url${ansi.reset}` +
      sep + `${theme.accent}^A${ansi.reset} ${theme.muted}note${ansi.reset}` +
      sep + `${theme.accent}^B${ansi.reset} ${theme.muted}${this.#cooking ? "stop cooking mode" : "cooking mode"}${ansi.reset}` +
      sep + `${theme.accent}esc${ansi.reset} ${theme.muted}back${ansi.reset}` +
      sep + (this.#detailStatus
        ? `${theme.good}${this.#detailStatus}${ansi.reset}`
        : `${theme.muted}${pct}${ansi.reset}`);

    return [...view, theme.faint + "─".repeat(cols) + ansi.reset, foot];
  }

  #renderScrape(cols: number, rows: number): string[] {
    const out: string[] = [];
    out.push(this.#header(cols));
    out.push(theme.faint + "─".repeat(cols) + ansi.reset);

    const viewH = rows - 4;
    const colored = this.#log.flatMap((l) => {
      const color = l.kind === "ok"
        ? theme.good
        : l.kind === "warn"
        ? theme.warn
        : l.kind === "err"
        ? theme.bad
        : theme.muted;
      return wrap(l.text, cols - 2).map((w) => ` ${color}${w}${ansi.reset}`);
    });

    const maxScroll = Math.max(0, colored.length - viewH);
    this.#logScroll = Math.min(this.#logScroll, maxScroll);
    const view = colored.slice(this.#logScroll, this.#logScroll + viewH);
    out.push(...view);
    for (let i = view.length; i < viewH; i++) out.push("");

    out.push(theme.faint + "─".repeat(cols) + ansi.reset);
    out.push(
      this.#busy
        ? ` ${theme.warn}working…${ansi.reset} ${theme.muted}esc to abort${ansi.reset}`
        : ` ${theme.accent}↵/esc${ansi.reset} ${theme.muted}back to search${ansi.reset}`,
    );
    return out.slice(0, rows);
  }

  #renderNote(cols: number, rows: number): string[] {
    const n = this.#note!;
    const out: string[] = [];
    const width = Math.min(cols - 4, 90);

    out.push(this.#header(cols));
    out.push(theme.faint + "─".repeat(cols) + ansi.reset);
    out.push(` ${theme.accentAlt}Note${ansi.reset} ${theme.muted}on${ansi.reset} ` +
      `${ansi.bold}${truncate(n.title, cols - 12)}${ansi.reset}`);
    out.push("");

    // Trailing "" keeps a final newline visible as an empty line to type on.
    const paragraphs = n.text.split("\n");
    const body: string[] = [];
    for (const p of paragraphs) {
      const wrapped = p === "" ? [""] : wrap(p, width);
      body.push(...wrapped);
    }
    const cursor = `${theme.accent}▏${ansi.reset}`;
    if (body.length === 0) body.push("");
    body[body.length - 1] = body[body.length - 1] + cursor;

    const viewH = rows - out.length - 2;
    const view = body.slice(Math.max(0, body.length - viewH));
    for (const l of view) out.push(`  ${l}`);
    for (let i = view.length; i < viewH; i++) out.push("");

    out.push(theme.faint + "─".repeat(cols) + ansi.reset);
    const hint = n.text.trim()
      ? "^S save · esc discard · ↵ newline · ^W word · ^U clear (empty note deletes it)"
      : "^S save · esc discard · ↵ newline";
    out.push(` ${theme.muted}${truncate(hint, cols - 2)}${ansi.reset}`);
    return out.slice(0, rows);
  }

  /** The prompt overlays the search screen's input row. */
  #renderPrompt(cols: number, rows: number): string[] {
    const base = this.#renderSearch(cols, rows);
    const p = this.#prompt!;
    base[2] = `${theme.accentAlt}${p.label}:${ansi.reset} ${p.value}${theme.accent}▏${ansi.reset}`;
    base[base.length - 1] = ` ${theme.muted}${truncate(p.hint, cols - 2)}${ansi.reset}`;
    return base;
  }
}
