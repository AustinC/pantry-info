/** Where pantry-info keeps its database and raw-HTML cache. */

function homeDir(): string {
  const h = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!h) throw new Error("cannot determine home directory (HOME unset)");
  return h;
}

/**
 * Data root, in precedence order:
 *   $PANTRY_INFO_DIR  ->  $XDG_DATA_HOME/pantry-info  ->  ~/.local/share/pantry-info
 */
export function dataDir(): string {
  const override = Deno.env.get("PANTRY_INFO_DIR");
  if (override) return override;
  const xdg = Deno.env.get("XDG_DATA_HOME");
  return `${xdg ?? `${homeDir()}/.local/share`}/pantry-info`;
}

export function dbPath(): string {
  return `${dataDir()}/pantry.db`;
}

/** Raw HTML cache, so a recipe can be re-parsed without re-fetching. */
export function pagesDir(): string {
  return `${dataDir()}/pages`;
}

/** The pre-existing Python scraper's store, used to bootstrap the DB offline. */
export function legacyChefJohnDir(): string {
  return `${homeDir()}/box/chefjohn`;
}

export function ensureDirs(): void {
  Deno.mkdirSync(pagesDir(), { recursive: true });
}
