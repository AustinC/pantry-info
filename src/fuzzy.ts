/**
 * fzf-style fuzzy matching over the local recipe index.
 *
 * A query term matches if its characters appear in order in the target. Scoring
 * rewards contiguous runs and word-boundary starts, so "carb" ranks
 * "Spaghetti alla Carbonara" above an incidental scatter of c-a-r-b.
 *
 * Multi-word queries are AND-ed: every term must hit some field. Fields are
 * weighted so a title hit beats an ingredient hit beats a description hit.
 */

import type { SearchRow } from "./db.ts";

export interface Match {
  row: SearchRow;
  score: number;
  /** Indices into the title that matched, for highlighting. */
  titleHits: number[];
}

const BONUS_BOUNDARY = 8;
const BONUS_CONSECUTIVE = 6;
const BONUS_START = 12;
const PENALTY_GAP = 1;

function isBoundary(prev: string | undefined): boolean {
  return prev === undefined || /[\s\-_/(,.]/.test(prev);
}

/**
 * Score one term against one text. Returns null when the term is not a
 * subsequence of the text. Also reports matched indices for highlighting.
 */
export function scoreTerm(
  term: string,
  text: string,
): { score: number; hits: number[] } | null {
  if (!term) return { score: 0, hits: [] };
  const hay = text.toLowerCase();
  const needle = term.toLowerCase();

  // Exact substring is the strong case — find the best-placed occurrence.
  let idx = hay.indexOf(needle);
  if (idx !== -1) {
    let best = -Infinity;
    let bestIdx = idx;
    while (idx !== -1) {
      let s = needle.length * (BONUS_CONSECUTIVE + 2);
      if (idx === 0) s += BONUS_START;
      else if (isBoundary(hay[idx - 1])) s += BONUS_BOUNDARY;
      // Prefer matches nearer the front of the field.
      s -= Math.min(idx, 20) * 0.25;
      if (s > best) { best = s; bestIdx = idx; }
      idx = hay.indexOf(needle, idx + 1);
    }
    return {
      score: best,
      hits: Array.from({ length: needle.length }, (_, k) => bestIdx + k),
    };
  }

  // Otherwise walk the text as a subsequence. A single greedy pass anchors on
  // the first occurrence of the leading character, which is often the wrong one
  // ("musroom" would latch onto the m in "Creamy" instead of "Mushroom"), so try
  // every plausible anchor and keep the best-scoring walk.
  let best: { score: number; hits: number[] } | null = null;
  let anchors = 0;
  for (let start = 0; start < hay.length && anchors < 32; start++) {
    if (hay[start] !== needle[0]) continue;
    anchors++;
    const attempt = walk(hay, needle, start);
    if (attempt && (!best || attempt.score > best.score)) best = attempt;
  }
  return best;
}

/** Greedy subsequence walk anchored at `start`. */
function walk(
  hay: string,
  needle: string,
  start: number,
): { score: number; hits: number[] } | null {
  const hits: number[] = [];
  let score = 0;
  let ti = start;
  let lastHit = -2;
  for (let ni = 0; ni < needle.length; ni++) {
    const ch = needle[ni];
    let found = -1;
    for (let k = ti; k < hay.length; k++) {
      if (hay[k] === ch) { found = k; break; }
    }
    if (found === -1) return null;
    if (found === lastHit + 1) score += BONUS_CONSECUTIVE;
    else if (lastHit >= 0) score -= Math.min(found - lastHit - 1, 10) * PENALTY_GAP;
    if (found === 0) score += BONUS_START;
    else if (isBoundary(hay[found - 1])) score += BONUS_BOUNDARY;
    hits.push(found);
    lastHit = found;
    ti = found + 1;
  }
  // Prefer tight matches near the front of the field.
  score -= Math.min(start, 20) * 0.25;
  return { score, hits };
}

interface Field {
  text: string;
  weight: number;
  isTitle?: boolean;
}

function fieldsOf(row: SearchRow): Field[] {
  return [
    { text: row.title, weight: 1.0, isTitle: true },
    { text: row.category ?? "", weight: 0.55 },
    { text: row.cuisine ?? "", weight: 0.55 },
    { text: row.keywords ?? "", weight: 0.4 },
    { text: row.ingredient_names, weight: 0.45 },
    // The user's own note ranks above the site's description: if they bothered
    // to write "mom's birthday cake", that should find the recipe.
    { text: row.note ?? "", weight: 0.6 },
    { text: row.description ?? "", weight: 0.22 },
  ];
}

/** Rank the index against a query. Empty query returns everything, best-rated first. */
export function search(rows: SearchRow[], query: string, limit = 200): Match[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (terms.length === 0) {
    return rows
      .slice()
      .sort((a, b) =>
        (b.starred ?? 0) - (a.starred ?? 0) ||
        (b.rating ?? 0) - (a.rating ?? 0) ||
        a.title.localeCompare(b.title)
      )
      .slice(0, limit)
      .map((row) => ({ row, score: 0, titleHits: [] }));
  }

  const out: Match[] = [];
  for (const row of rows) {
    const fields = fieldsOf(row);
    let total = 0;
    let titleHits: number[] = [];
    let allTermsMatched = true;

    for (const term of terms) {
      let bestForTerm = -Infinity;
      let bestTitleHits: number[] | null = null;
      for (const f of fields) {
        if (!f.text) continue;
        const r = scoreTerm(term, f.text);
        if (!r) continue;
        const weighted = r.score * f.weight;
        if (weighted > bestForTerm) {
          bestForTerm = weighted;
          bestTitleHits = f.isTitle ? r.hits : null;
        }
      }
      if (bestForTerm === -Infinity) { allTermsMatched = false; break; }
      total += bestForTerm;
      if (bestTitleHits) titleHits = titleHits.concat(bestTitleHits);
    }
    if (!allTermsMatched) continue;

    // Gentle tiebreaks: well-rated and shorter-titled recipes float up.
    total += (row.rating ?? 0) * 1.5;
    total -= row.title.length * 0.05;

    out.push({ row, score: total, titleHits: [...new Set(titleHits)].sort((a, b) => a - b) });
  }

  // Starred recipes are a hard first tier, not a score bonus: a favourite that
  // matches at all outranks any unstarred match, however strong.
  out.sort((a, b) =>
    (b.row.starred ?? 0) - (a.row.starred ?? 0) ||
    b.score - a.score ||
    a.row.title.localeCompare(b.row.title)
  );
  return out.slice(0, limit);
}
