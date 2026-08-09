import { assertEquals } from "@std/assert";
import {
  allrecipesId,
  buildRecipe,
  extractRecipeLinks,
  extractRecipeNode,
  isChefJohn,
  humanDuration,
  normalizeUrl,
} from "../src/scraper.ts";

Deno.test("reads allrecipes ids from both URL shapes, slug optional", () => {
  assertEquals(allrecipesId("https://www.allrecipes.com/recipe/219171/classic-meatloaf/"), "219171");
  assertEquals(allrecipesId("https://www.allrecipes.com/chili-crisp-cold-noodles-recipe-12010634"), "12010634");
  // Rebuilt from the HTML cache, so there is no slug — must still yield the id
  // rather than falling back to a content hash.
  assertEquals(allrecipesId("https://www.allrecipes.com/recipe/261198/"), "261198");
});

Deno.test("canonicalizes URLs so search hits and JSON-LD agree", () => {
  const a = normalizeUrl("https://www.allrecipes.com/recipe/233582/chef-johns-blt-pasta");
  const b = normalizeUrl("https://www.allrecipes.com/recipe/233582/chef-johns-blt-pasta/?x=1#top");
  assertEquals(a, b);
});

Deno.test("extracts and de-duplicates recipe links", () => {
  const html = `
    <a href="https://www.allrecipes.com/recipe/1/aaa-bbb/">a</a>
    <a href="https://www.allrecipes.com/recipe/1/aaa-bbb/">dupe</a>
    <a href="https://www.allrecipes.com/recipe/2/ccc-ddd/">b</a>`;
  const links = extractRecipeLinks(html);
  assertEquals(links.length, 2);
  assertEquals(links[0].sourceId, "1");
  assertEquals(links[0].slug, "aaa-bbb");
});

const PAGE = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
 {"@type":"WebPage","name":"ignore me"},
 {"@type":["Recipe"],"name":"Chef John&#39;s Test Pasta",
  "author":{"@type":"Person","name":"Chef John"},
  "description":"A <b>tasty</b> test.",
  "recipeYield":["4"],"totalTime":"PT1H30M",
  "recipeCategory":["Dinner"],"recipeCuisine":["Italian"],
  "aggregateRating":{"ratingValue":"4.7","ratingCount":"120"},
  "recipeIngredient":["2 tablespoons olive oil","3 cloves garlic, minced"],
  "recipeInstructions":[{"@type":"HowToStep","text":"Heat the oil."},
                        {"@type":"HowToStep","text":"Add the garlic."}]}
]}</script></head><body></body></html>`;

Deno.test("parses a schema.org Recipe out of a page", () => {
  const node = extractRecipeNode(PAGE);
  assertEquals(isChefJohn(node), true);

  const r = buildRecipe(node, "https://www.allrecipes.com/recipe/999/chef-johns-test-pasta/");
  assertEquals(r?.title, "Chef John's Test Pasta"); // entity-decoded
  assertEquals(r?.sourceId, "999");
  assertEquals(r?.source, "allrecipes.com");
  assertEquals(r?.rating, 4.7);
  assertEquals(r?.ratingCount, 120);
  assertEquals(r?.servings, "4");
  assertEquals(r?.description, "A tasty test."); // tags stripped
  assertEquals(r?.instructions.length, 2);
  assertEquals(r?.ingredients.length, 2);
  assertEquals(r?.ingredients[1].unit, "clove");
  assertEquals(r?.ingredients[1].name, "garlic");
});

Deno.test("rejects pages by other authors", () => {
  // Replace only the author node — the title also contains "Chef John".
  const node = extractRecipeNode(
    PAGE.replace('"Person","name":"Chef John"', '"Person","name":"Someone Else"'),
  );
  assertEquals(isChefJohn(node), false);
  assertEquals(isChefJohn(extractRecipeNode(PAGE)), true);
});

Deno.test("formats ISO durations", () => {
  assertEquals(humanDuration("PT1H30M"), "1 hr 30 min");
  assertEquals(humanDuration("PT45M"), "45 min");
  assertEquals(humanDuration(null), null);
});
