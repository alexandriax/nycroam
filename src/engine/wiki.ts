// Live Wikipedia lookup for the building-info modal. Called once when the modal
// opens; results are cached in-memory for the session. Uses the official
// Wikimedia REST summary API (CORS-enabled, no key) — a single GET per building,
// never bulk/scraped. Degrades to null (modal hides the section) on any failure.

export interface WikiSummary {
  title: string;
  extract: string;
  url: string;
  thumbnail?: string;
}

const cache = new Map<string, WikiSummary | null>();

/** Hints carried on a plaque record, in priority order. */
export interface WikiHints {
  wp?: string;   // OSM "wikipedia" tag: "lang:Title"
  wd?: string;   // OSM "wikidata" id: "Q..."
  name?: string; // fall back to a curated landmark name
}

async function summaryFor(lang: string, title: string): Promise<WikiSummary | null> {
  const res = await fetch(
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?redirect=true`,
    { headers: { accept: 'application/json' } },
  );
  if (!res.ok) return null;
  const j = await res.json();
  if (!j || j.type === 'disambiguation' || !j.extract) return null;
  return {
    title: j.title ?? title,
    extract: j.extract,
    url: j.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    thumbnail: j.thumbnail?.source,
  };
}

/** Resolve a Wikidata Q-id to its English Wikipedia title. */
async function titleFromWikidata(qid: string): Promise<string | null> {
  const res = await fetch(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qid)}` +
      `&props=sitelinks&format=json&origin=*`,
    { headers: { accept: 'application/json' } },
  );
  if (!res.ok) return null;
  const j = await res.json();
  return j?.entities?.[qid]?.sitelinks?.enwiki?.title ?? null;
}

/**
 * Best available Wikipedia summary for a building. Tries the OSM wikipedia tag,
 * then the wikidata id, then a curated landmark name. Returns null when nothing
 * resolves. Cached per hint-set for the session.
 */
export async function fetchWiki(h: WikiHints): Promise<WikiSummary | null> {
  const key = `${h.wp ?? ''}|${h.wd ?? ''}|${h.name ?? ''}`;
  if (cache.has(key)) return cache.get(key)!;

  let result: WikiSummary | null = null;
  try {
    if (h.wp && h.wp.includes(':')) {
      const idx = h.wp.indexOf(':');
      result = await summaryFor(h.wp.slice(0, idx), h.wp.slice(idx + 1));
    }
    if (!result && h.wd) {
      const title = await titleFromWikidata(h.wd);
      if (title) result = await summaryFor('en', title);
    }
    if (!result && h.name) {
      result = await summaryFor('en', h.name);
    }
  } catch {
    result = null;
  }
  cache.set(key, result);
  return result;
}
