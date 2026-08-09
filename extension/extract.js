/**
 * Injected into the active tab to pull the schema.org Recipe out of the page.
 *
 * This deliberately extracts the raw JSON-LD rather than a digested recipe:
 * pantry-info runs it through the same parser it uses for scraped pages, so a
 * manual capture and an automated scrape produce byte-identical rows.
 *
 * Defined as a plain function expression so popup.js can hand it to
 * scripting.executeScript({ func }) — it is serialised, not imported.
 */
function extractRecipeFromPage() {
  const findRecipeNode = (node) => {
    if (Array.isArray(node)) {
      for (const n of node) {
        const found = findRecipeNode(n);
        if (found) return found;
      }
      return null;
    }
    if (node && typeof node === "object") {
      const type = node["@type"];
      const types = Array.isArray(type) ? type : [type];
      if (types.includes("Recipe")) return node;
      if (node["@graph"]) return findRecipeNode(node["@graph"]);
    }
    return null;
  };

  let jsonld = null;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed;
    try {
      parsed = JSON.parse(script.textContent);
    } catch {
      try {
        parsed = JSON.parse(script.textContent.trim().replace(/;\s*$/, ""));
      } catch {
        continue;
      }
    }
    const found = findRecipeNode(parsed);
    if (found) {
      jsonld = found;
      break;
    }
  }

  if (!jsonld) {
    return { ok: false, error: "No schema.org Recipe data found on this page." };
  }

  // Prefer the page's canonical URL so a capture and a scrape agree on identity.
  const canonical = document.querySelector('link[rel="canonical"]')?.href;

  const names = (value) => {
    const list = Array.isArray(value) ? value : [value];
    return list
      .map((v) => (typeof v === "string" ? v : v && typeof v === "object" ? v.name : null))
      .filter(Boolean);
  };

  return {
    ok: true,
    envelope: {
      pantryInfo: 1,
      url: canonical || location.href,
      capturedAt: new Date().toISOString(),
      jsonld,
      html: document.documentElement.outerHTML,
    },
    preview: {
      title: typeof jsonld.name === "string" ? jsonld.name : "(untitled)",
      author: names(jsonld.author)[0] || null,
      ingredients: Array.isArray(jsonld.recipeIngredient) ? jsonld.recipeIngredient.length : 0,
      steps: Array.isArray(jsonld.recipeInstructions) ? jsonld.recipeInstructions.length : 0,
      host: location.hostname.replace(/^www\./, ""),
    },
  };
}
