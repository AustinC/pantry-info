/**
 * Clipboard support for the TUI.
 *
 * Two strategies, in order:
 *   1. A native helper (wl-copy / xclip / xsel / pbcopy) when --allow-run covers it.
 *   2. OSC 52, which asks the terminal itself to set the clipboard. This needs no
 *      permissions and works over SSH, but not every terminal honours it.
 *
 * Permission is checked with querySync rather than by catching a failure, because
 * an interactive permission prompt would draw over the alt-screen and corrupt the UI.
 */

const CANDIDATES: { cmd: string; args: string[] }[] = [
  { cmd: "wl-copy", args: [] },
  { cmd: "xclip", args: ["-selection", "clipboard"] },
  { cmd: "xsel", args: ["--clipboard", "--input"] },
  { cmd: "pbcopy", args: [] },
];

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * OSC 52. Inside tmux the sequence must be wrapped in a DCS passthrough and its
 * escapes doubled, or tmux swallows it instead of forwarding it to the terminal.
 */
function osc52(text: string): string {
  const seq = `\x1b]52;c;${base64(text)}\x07`;
  if (Deno.env.get("TMUX")) return `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
  return seq;
}

async function tryNativeCopy(text: string): Promise<string | null> {
  for (const { cmd, args } of CANDIDATES) {
    let allowed = false;
    try {
      allowed = Deno.permissions.querySync({ name: "run", command: cmd }).state === "granted";
    } catch {
      allowed = false;
    }
    if (!allowed) continue;

    try {
      const child = new Deno.Command(cmd, { args, stdin: "piped", stdout: "null", stderr: "null" })
        .spawn();
      const w = child.stdin.getWriter();
      await w.write(new TextEncoder().encode(text));
      await w.close();
      if ((await child.status).success) return cmd;
    } catch {
      // Not installed, or it failed — fall through to the next candidate.
    }
  }
  return null;
}

export interface CopyResult {
  ok: boolean;
  /** How it was copied, for the status line. */
  via: string;
}

/**
 * Copy `text`, returning how it was done. `emit` writes the OSC 52 fallback to the
 * terminal; the caller supplies it so writes stay funnelled through the renderer.
 */
export async function copyToClipboard(
  text: string,
  emit: (s: string) => void,
): Promise<CopyResult> {
  const native = await tryNativeCopy(text);
  if (native) return { ok: true, via: native };
  emit(osc52(text));
  return { ok: true, via: "OSC 52" };
}
