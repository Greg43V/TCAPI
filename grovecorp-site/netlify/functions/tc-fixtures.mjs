// netlify/functions/tc-fixtures.mjs
// Serves the fixtures list for a competition by READING THE CACHE the scheduled
// poller writes. Makes ZERO calls to TC — so any number of visitors costs nothing
// against the rate limit, and the page loads instantly.

import { getStore } from "@netlify/blobs";

const ALLOWED_COMPETITIONS = [401]; // Premier League only, for now

export default async (req) => {
  const url = new URL(req.url);
  const competition = parseInt(url.searchParams.get("competition") || "401", 10);
  const headers = { "content-type": "application/json", "cache-control": "public, max-age=60" };

  if (!ALLOWED_COMPETITIONS.includes(competition)) {
    return new Response(JSON.stringify({ error: "That competition is not enabled on this site." }), { status: 403, headers });
  }

  const store = getStore("tc-cache");
  let products = null, prices = null;
  try { products = await store.get("products", { type: "json" }); } catch (_) {}
  try { prices = await store.get("prices", { type: "json" }); } catch (_) {}

  if (!products) {
    // Poller hasn't run yet (fresh deploy). Ask the page to try again shortly.
    return new Response(JSON.stringify({ warming: true, fixtures: [] }), { status: 200, headers });
  }

  const now = Date.now();
  const byId = (prices && prices.by_id) || {};
  const fixtures = products.list
    .filter((p) => p.competition === competition && new Date(p.utc).getTime() > now)
    .sort((a, b) => new Date(a.utc) - new Date(b.utc))
    .map((p) => {
      const cats = byId[p.id];
      let from = null, sold_out = false, priced = false;
      if (Array.isArray(cats)) {
        priced = true;
        const avail = cats.filter((c) => c.available).map((c) => c.price);
        if (avail.length) from = Math.min(...avail); else sold_out = true;
      }
      return { id: p.id, name: p.name, date: p.date, currency: p.currency || "GBP", from, priced, sold_out };
    });

  return new Response(JSON.stringify({ competition, count: fixtures.length, fixtures,
    prices_updated: prices ? prices.ts : null }), { status: 200, headers });
};
