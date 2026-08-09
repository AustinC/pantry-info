/**
 * Minimal terminal layer: raw-mode key decoding, ANSI styling, alt-screen
 * management. No dependencies — the whole UI is a string rendered per frame.
 */

const enc = new TextEncoder();

export const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  reverse: "\x1b[7m",
  fg: (n: number) => `\x1b[38;5;${n}m`,
  bg: (n: number) => `\x1b[48;5;${n}m`,
};

export const theme = {
  accent: ansi.fg(75),
  accentAlt: ansi.fg(215),
  muted: ansi.fg(245),
  faint: ansi.fg(240),
  good: ansi.fg(114),
  warn: ansi.fg(179),
  bad: ansi.fg(203),
  hit: ansi.fg(215) + ansi.bold,
  selBg: ansi.bg(238),
};

export function write(s: string): void {
  Deno.stdout.writeSync(enc.encode(s));
}

export function size(): { cols: number; rows: number } {
  try {
    const { columns, rows } = Deno.consoleSize();
    return { cols: Math.max(40, columns), rows: Math.max(10, rows) };
  } catch {
    return { cols: 80, rows: 24 };
  }
}

export function enterAlt(): void {
  write("\x1b[?1049h\x1b[?25l");
}

export function exitAlt(): void {
  write("\x1b[?25h\x1b[?1049l");
}

export function clearScreen(): string {
  return "\x1b[H\x1b[2J";
}

// ---------------------------------------------------------------------------
// Key input
// ---------------------------------------------------------------------------

export interface Key {
  name: string;
  ctrl: boolean;
  alt: boolean;
  /** The literal character for printable keys. */
  ch?: string;
}

const SS3: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const CSI_TILDE: Record<string, string> = {
  "1": "home", "2": "insert", "3": "delete", "4": "end",
  "5": "pageup", "6": "pagedown", "7": "home", "8": "end",
};

/** Decode one chunk of stdin bytes into zero or more key events. */
export function decodeKeys(bytes: Uint8Array): Key[] {
  const s = new TextDecoder().decode(bytes);
  const keys: Key[] = [];
  let i = 0;

  while (i < s.length) {
    const c = s[i];

    if (c === "\x1b") {
      // CSI sequence: ESC [ ... final
      const csi = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(s.slice(i));
      if (csi) {
        const [, params, final] = csi;
        if (final === "~") keys.push(key(CSI_TILDE[params.split(";")[0]] ?? "unknown"));
        else if (SS3[final]) keys.push(key(SS3[final]));
        else if (final === "Z") keys.push(key("backtab"));
        else keys.push(key("unknown"));
        i += csi[0].length;
        continue;
      }
      // SS3: ESC O <letter>
      const ss3 = /^\x1bO([A-Za-z])/.exec(s.slice(i));
      if (ss3) {
        keys.push(key(SS3[ss3[1]] ?? "unknown"));
        i += ss3[0].length;
        continue;
      }
      // Alt+char, but only for a printable follower. Terminals (and ptys) may
      // pad a bare Escape with NUL or deliver it next to unrelated control
      // bytes; treating those as Alt+<control> would swallow the Escape key.
      const next = s[i + 1];
      if (next !== undefined && next >= " " && next !== "\x7f") {
        keys.push({ name: next, ctrl: false, alt: true, ch: next });
        i += 2;
        continue;
      }
      keys.push(key("escape"));
      i += 1;
      continue;
    }

    if (c === "\x00") { i++; continue; } // padding, not a keypress

    if (c === "\r" || c === "\n") { keys.push(key("enter")); i++; continue; }
    if (c === "\t") { keys.push(key("tab")); i++; continue; }
    if (c === "\x7f" || c === "\b") { keys.push(key("backspace")); i++; continue; }

    const code = c.charCodeAt(0);
    if (code < 32) {
      // Ctrl+letter
      keys.push({ name: String.fromCharCode(code + 96), ctrl: true, alt: false });
      i++;
      continue;
    }

    keys.push({ name: c, ctrl: false, alt: false, ch: c });
    i++;
  }
  return keys;
}

function key(name: string): Key {
  return { name, ctrl: false, alt: false };
}

/** Async stream of key events from stdin in raw mode. */
export async function* keyStream(signal?: AbortSignal): AsyncGenerator<Key> {
  const buf = new Uint8Array(1024);
  while (!signal?.aborted) {
    const n = await Deno.stdin.read(buf);
    if (n === null) return;
    for (const k of decodeKeys(buf.subarray(0, n))) yield k;
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Visible width, ignoring ANSI escapes. */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

export function stripAnsi(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** Truncate to `n` visible columns, appending an ellipsis when cut. */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return n <= 1 ? s.slice(0, n) : s.slice(0, n - 1) + "…";
}

export function padEnd(s: string, n: number): string {
  const w = visibleWidth(s);
  return w >= n ? s : s + " ".repeat(n - w);
}

/** Wrap plain text to a column width. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para.trim()) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out;
}

/** Apply highlight styling at the given character indices. */
export function highlight(text: string, hits: number[], base: string): string {
  if (hits.length === 0) return base + text;
  const set = new Set(hits);
  let out = base;
  let on = false;
  for (let i = 0; i < text.length; i++) {
    const want = set.has(i);
    if (want && !on) { out += theme.hit; on = true; }
    else if (!want && on) { out += ansi.reset + base; on = false; }
    out += text[i];
  }
  return out + (on ? ansi.reset + base : "");
}
