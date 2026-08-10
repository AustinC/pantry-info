import { assertEquals } from "@std/assert";
import { DIGIT_HEIGHT, renderStepNumber, stepNumberWidth } from "../src/tui/bigNumber.ts";

Deno.test("every glyph is exactly DIGIT_HEIGHT rows tall", () => {
  for (let n = 0; n <= 9; n++) {
    assertEquals(renderStepNumber(n).length, DIGIT_HEIGHT);
  }
});

Deno.test("every row of a single digit is 3 columns wide", () => {
  for (let n = 0; n <= 9; n++) {
    for (const row of renderStepNumber(n)) assertEquals(row.length, 3);
  }
});

Deno.test("digits are visually distinct from each other", () => {
  const glyphs = new Set<string>();
  for (let n = 0; n <= 9; n++) glyphs.add(renderStepNumber(n).join("\n"));
  assertEquals(glyphs.size, 10);
});

Deno.test("pads shorter numbers so width stays constant across a recipe's steps", () => {
  const nine = renderStepNumber(9, 2);
  const ten = renderStepNumber(10, 2);
  assertEquals(nine[0].length, ten[0].length);
  // The padded leading digit of "9" is fully blank.
  for (const row of nine) assertEquals(row.slice(0, 3), "   ");
});

Deno.test("multi-digit glyphs are digit glyphs joined with a single space", () => {
  const twelve = renderStepNumber(12, 2);
  const one = renderStepNumber(1);
  const two = renderStepNumber(2);
  twelve.forEach((row, i) => {
    assertEquals(row, `${one[i]} ${two[i]}`);
  });
});

Deno.test("stepNumberWidth matches the actual rendered width", () => {
  assertEquals(stepNumberWidth(1), renderStepNumber(5, 1)[0].length);
  assertEquals(stepNumberWidth(2), renderStepNumber(5, 2)[0].length);
  assertEquals(stepNumberWidth(3), renderStepNumber(5, 3)[0].length);
});
