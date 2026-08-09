/**
 * Localhost endpoint for the browser extension.
 *
 * Bound to the loopback interface only. It is intentionally unauthenticated —
 * any local process can post a recipe — which is an acceptable trade for a
 * personal tool whose only side effect is adding rows to your own recipe
 * database. Nothing here reads or returns data from the database.
 */

import type { Db } from "./db.ts";
import { ingestEnvelope, IngestError, parseEnvelope } from "./ingest.ts";
import type { Progress } from "./jobs.ts";

export const DEFAULT_PORT = 8787;

/** 2 MB is generous for JSON-LD plus a cached page, and bounds memory use. */
const MAX_BODY = 2 * 1024 * 1024;

const CORS = {
  // The caller is a moz-extension:// origin, which cannot be predicted.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export interface ReceiverOptions {
  port?: number;
  signal?: AbortSignal;
  /** Called after each stored recipe, for the CLI's running total. */
  onStored?: (title: string) => void;
}

export function serveReceiver(db: Db, progress: Progress, opts: ReceiverOptions = {}) {
  const port = opts.port ?? DEFAULT_PORT;

  return Deno.serve({
    port,
    hostname: "127.0.0.1",
    signal: opts.signal,
    onListen: () => {
      progress(`listening on http://127.0.0.1:${port} — leave this running`, "ok");
      progress(`waiting for captures from the browser extension…`);
    },
  }, async (req) => {
    const { pathname } = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // Lets the extension show a connected/disconnected indicator.
    if (req.method === "GET" && (pathname === "/ping" || pathname === "/")) {
      return json({ ok: true, app: "pantry-info", recipes: db.stats().recipes });
    }

    if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);

    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BODY) return json({ ok: false, error: "payload too large" }, 413);

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json({ ok: false, error: "body is not valid JSON" }, 400);
    }

    try {
      const { recipe, updated } = ingestEnvelope(db, parseEnvelope(raw));
      progress(
        `${updated ? "updated" : "+"} ${recipe.title} (${recipe.ingredients.length} ingredients)`,
        "ok",
      );
      opts.onStored?.(recipe.title);
      return json({
        ok: true,
        title: recipe.title,
        ingredients: recipe.ingredients.length,
        updated,
      });
    } catch (e) {
      const msg = (e as Error).message;
      progress(`rejected: ${msg}`, "err");
      return json({ ok: false, error: msg }, e instanceof IngestError ? 422 : 500);
    }
  });
}
