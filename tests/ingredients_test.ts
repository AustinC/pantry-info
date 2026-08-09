import { assertEquals } from "@std/assert";
import { normalizeName, parseIngredient } from "../src/ingredients.ts";

Deno.test("splits amount, unit and name", () => {
  const p = parseIngredient("2.5 pounds ground chuck");
  assertEquals(p.quantity, 2.5);
  assertEquals(p.unit, "pound");
  assertEquals(p.name, "ground chuck");
});

Deno.test("handles mixed and vulgar fractions", () => {
  assertEquals(parseIngredient("1 1/2 cups flour").quantity, 1.5);
  const v = parseIngredient("1½ cups whole milk");
  assertEquals(v.quantity, 1.5);
  assertEquals(v.unit, "cup");
  assertEquals(v.name, "whole milk");
  assertEquals(parseIngredient("1/2 teaspoon salt").quantity, 0.5);
});

Deno.test("handles ranges", () => {
  const p = parseIngredient("2 to 3 tablespoons olive oil");
  assertEquals(p.quantity, 2);
  assertEquals(p.quantityMax, 3);
  assertEquals(p.unit, "tablespoon");
  assertEquals(p.name, "olive oil");
});

Deno.test("extracts package sizes, including leading-dot decimals", () => {
  const p = parseIngredient("1 (14.5 ounce) can diced tomatoes, drained");
  assertEquals(p.quantity, 1);
  assertEquals(p.packSize, 14.5);
  assertEquals(p.packUnit, "ounce");
  assertEquals(p.unit, "can");
  assertEquals(p.name, "diced tomatoes");
  assertEquals(p.note, "drained");

  assertEquals(parseIngredient("1 (.25 ounce) envelope active dry yeast").packSize, 0.25);
});

Deno.test("steps over size adjectives to find the unit", () => {
  const p = parseIngredient("8 thick slices bacon, cooked crisp");
  assertEquals(p.quantity, 8);
  assertEquals(p.unit, "slice");
  assertEquals(p.name, "bacon");
});

Deno.test("separates a prep note from the name", () => {
  const p = parseIngredient("3 cloves garlic, coarsely chopped");
  assertEquals(p.unit, "clove");
  assertEquals(p.name, "garlic");
  assertEquals(p.note, "coarsely chopped");
});

Deno.test("marks optional ingredients", () => {
  assertEquals(parseIngredient("1 pinch cayenne pepper, optional").optional, true);
  assertEquals(parseIngredient("1 pinch cayenne pepper").optional, false);
});

Deno.test("detects section headings", () => {
  assertEquals(parseIngredient("Relish").isHeading, true);
  assertEquals(parseIngredient("For the sauce:").isHeading, true);
  assertEquals(parseIngredient("2 cups flour").isHeading, false);
  assertEquals(parseIngredient("cooking spray").isHeading, false);
});

Deno.test("normalizes names for pantry matching", () => {
  // Different forms of the same pantry item collapse together.
  assertEquals(normalizeName("anchovy fillets"), "anchovy");
  assertEquals(normalizeName("chopped fresh tomatoes"), "tomato");
  assertEquals(normalizeName("Kalamata olives"), "kalamata olive");
  // ...but genuinely distinct items stay distinct.
  assertEquals(normalizeName("hot sauce"), "hot sauce");
  assertEquals(normalizeName("olive oil"), "olive oil");
});

Deno.test("tolerates lines with no amount", () => {
  const p = parseIngredient("salt and freshly ground black pepper to taste");
  assertEquals(p.quantity, null);
  assertEquals(p.unit, null);
  assertEquals(p.nameNorm, "salt black pepper");
});
