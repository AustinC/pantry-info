/**
 * Polite, resumable HTTP fetching.
 *
 * allrecipes fingerprints requests: a bare User-Agent gets a 403 "Simple Page"
 * interstitial, while a complete, self-consistent Chrome header set (UA +
 * matching sec-ch-ua + Sec-Fetch-*) is served normally. Profiles below keep the
 * UA and client hints in sync — rotating the UA alone re-triggers the block.
 *
 * Requests are sequential with a randomised delay, and back off exponentially on
 * 403/429/5xx while honouring Retry-After.
 */

interface Profile {
  ua: string;
  chUa: string;
  platform: string;
}

const PROFILES: Profile[] = [
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    chUa: '"Chromium";v="131", "Not_A Brand";v="24"',
    platform: '"Linux"',
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    chUa: '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    platform: '"Windows"',
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    chUa: '"Chromium";v="131", "Not_A Brand";v="24"',
    platform: '"macOS"',
  },
];

export interface FetcherOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  onLog?: (msg: string) => void;
}

export class Fetcher {
  #profile = 0;
  #lastRequest = 0;
  #minDelay: number;
  #maxDelay: number;
  #maxRetries: number;
  #log: (msg: string) => void;

  constructor(opts: FetcherOptions = {}) {
    this.#minDelay = opts.minDelayMs ?? 2500;
    this.#maxDelay = opts.maxDelayMs ?? 6000;
    this.#maxRetries = opts.maxRetries ?? 4;
    this.#log = opts.onLog ?? (() => {});
  }

  #headers(referer?: string): HeadersInit {
    const p = PROFILES[this.#profile % PROFILES.length];
    const h: Record<string, string> = {
      "User-Agent": p.ua,
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "sec-ch-ua": p.chUa,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": p.platform,
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": referer ? "same-origin" : "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    };
    if (referer) h["Referer"] = referer;
    return h;
  }

  async #politeWait(): Promise<void> {
    const gap = this.#minDelay + Math.random() * (this.#maxDelay - this.#minDelay);
    const elapsed = performance.now() - this.#lastRequest;
    if (this.#lastRequest && elapsed < gap) {
      await new Promise((r) => setTimeout(r, gap - elapsed));
    }
  }

  /** GET a page, returning its HTML, or null once retries are exhausted. */
  async get(url: string, referer?: string, signal?: AbortSignal): Promise<string | null> {
    let backoff = 5000;
    for (let attempt = 1; attempt <= this.#maxRetries; attempt++) {
      if (signal?.aborted) return null;
      await this.#politeWait();
      let res: Response;
      try {
        res = await fetch(url, { headers: this.#headers(referer), redirect: "follow", signal });
      } catch (err) {
        if (signal?.aborted) return null;
        this.#log(`network error: ${(err as Error).message} (retry ${attempt}/${this.#maxRetries})`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 120_000);
        continue;
      } finally {
        this.#lastRequest = performance.now();
      }

      if (res.ok) return await res.text();
      await res.body?.cancel();

      if ([403, 429, 500, 502, 503, 504].includes(res.status)) {
        const ra = Number(res.headers.get("Retry-After"));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff;
        if (res.status === 403 || res.status === 429) {
          this.#profile++;
          this.#log(`HTTP ${res.status} — rotating browser profile, waiting ${Math.round(wait / 1000)}s`);
        } else {
          this.#log(`HTTP ${res.status} — waiting ${Math.round(wait / 1000)}s`);
        }
        await new Promise((r) => setTimeout(r, wait + Math.random() * 2000));
        backoff = Math.min(backoff * 2, 120_000);
        continue;
      }
      this.#log(`HTTP ${res.status} on ${url} — skipping`);
      return null;
    }
    this.#log(`gave up on ${url}`);
    return null;
  }
}
