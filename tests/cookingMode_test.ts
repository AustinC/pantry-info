import { assertEquals } from "@std/assert";
import { checkAvailability, DURATION_SECONDS } from "../src/tui/cookingMode.ts";

Deno.test("unavailable on non-Linux regardless of permission", () => {
  assertEquals(checkAvailability("darwin", true).ok, false);
  assertEquals(checkAvailability("windows", true).ok, false);
});

Deno.test("unavailable on Linux without run permission", () => {
  const r = checkAvailability("linux", false);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason.includes("permission"), true);
});

Deno.test("available on Linux with run permission", () => {
  assertEquals(checkAvailability("linux", true), { ok: true });
});

Deno.test("the safety-net duration is 90 minutes", () => {
  assertEquals(DURATION_SECONDS, 90 * 60);
});
