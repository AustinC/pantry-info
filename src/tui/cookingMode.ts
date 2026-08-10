/**
 * Cooking mode: keep the monitor from sleeping while a recipe is open.
 *
 * Implemented via `systemd-inhibit`, which holds an idle/sleep inhibitor for as
 * long as its child process runs. Spawning `sleep <duration>` under it means the
 * inhibitor — and cooking mode — releases itself automatically after the cap,
 * even if the user forgets to turn it off; explicit toggle-off just kills that
 * child early. Either way, there is exactly one thing to clean up: this process.
 *
 * Linux/systemd only. Anywhere else, `start` reports why it can't run rather
 * than silently doing nothing.
 */

/** 1.5 hours — long enough for most recipes, short enough to not matter if forgotten. */
export const DURATION_SECONDS = 90 * 60;

export interface Unavailable {
  ok: false;
  reason: string;
}

export interface Available {
  ok: true;
}

/**
 * Pure eligibility check, separated from the real `Deno.build`/`Deno.permissions`
 * calls so it can be unit-tested with fake inputs.
 */
export function checkAvailability(os: string, runPermissionGranted: boolean): Unavailable | Available {
  if (os !== "linux") {
    return { ok: false, reason: "needs systemd-inhibit, which is Linux-only" };
  }
  if (!runPermissionGranted) {
    return { ok: false, reason: "no permission to run systemd-inhibit (see --allow-run)" };
  }
  return { ok: true };
}

export interface CookingModeHandle {
  /** Kill the inhibitor now. Safe to call more than once. */
  stop(): Promise<void>;
}

export type StartResult =
  | { ok: true; handle: CookingModeHandle }
  | { ok: false; reason: string };

/**
 * Start the inhibitor. `onExpire` fires if the process runs to the end of its
 * duration on its own — i.e. the user never called `stop()` — so the caller can
 * keep its own "is cooking mode on" state truthful. It never fires after an
 * explicit `stop()`, including one that races the natural expiry.
 */
export function startCookingMode(why: string, onExpire: () => void): StartResult {
  let permitted = false;
  try {
    permitted = Deno.permissions.querySync({ name: "run", command: "systemd-inhibit" }).state ===
      "granted";
  } catch {
    permitted = false;
  }
  const availability = checkAvailability(Deno.build.os, permitted);
  if (!availability.ok) return availability;

  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("systemd-inhibit", {
      args: [
        "--what=idle:sleep",
        `--why=${why}`,
        "--mode=block",
        "sleep",
        String(DURATION_SECONDS),
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
  } catch (e) {
    return { ok: false, reason: `could not start systemd-inhibit: ${(e as Error).message}` };
  }

  // Set synchronously, before any await, so a `stop()` call can never race
  // with this resolving — whichever happens first wins outright.
  let stopped = false;
  child.status.then(() => {
    if (!stopped) {
      stopped = true;
      onExpire();
    }
  }).catch(() => {});

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
    // Wait for the reap, but don't hang the app on it — a couple of seconds
    // is more than enough for SIGTERM to land.
    await Promise.race([
      child.status.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  };

  return { ok: true, handle: { stop } };
}
