// netlify/functions/tc-poll.mjs
// SCHEDULED background poller — the heart of TC-compliant operation.
//
// Requirement #1 (recommended process): product search runs at most hourly;
// inventory-status runs every minute; results are cached for pages to read.
// Requirement #2 (rate limit): never more than ~30 TC calls in a single run,
// plus a rolling-window throttle capping at 50 calls / 60s. Well under TC's 60/min.
//
// Runs once per minute (see `export const config` at the bottom). On each run it
// EITHER refreshes the product list (once an hour) OR refreshes prices (the other
// 59 minutes) — never both in the same minute, so no minute ever approaches 60 calls.
//
// It writes one JSON blob ("snapshot") holding every fixture + every priced
// category. The public pages read that blob and make ZERO calls to TC.
//
// Env vars: TC_USERNAME, TC_PASSWORD, TC_BASE, TC_MARGIN_PCT, TC_ROUND_TO (optional)

import { getStore } from "@netlify/blobs";

const BASE = process.env.TC_BASE || "https://api-sandbox.travelconnectionleisure.com/v1";
const MARGIN_PCT = parseFloat(process.env.TC_MARGIN_PCT || "0");
const ROUND_TO = parseFloat(process.env.TC_ROUND_TO || "1");

const PRODUCT_SEARCH_INTERVAL_MS = 60 * 60 * 1000; // refresh product list hourly
const RATE_MAX = 50;                                // hard ceiling: calls per rolling 60s
const CONCURRENCY = 4;

// ---- rolling-window rate limiter (belt-and-braces under TC's 60/min) ----
const callTimes = [];
async function throttle() {
  const now = Date.now();
  while (callTimes.length && now - callTimes[0] > 60000) callTimes.shift();
  if (callTimes.length >= RATE_MAX) {
    const wait = 60000 - (now - callTimes[0]) + 50;
    await new Promise((r) => setTimeout(r, wait));
  }
  callTimes.push(Date.now());
}

async function tokenFetch(store) {
  // reuse a token from the blob if still valid, else authenticate
  let tok = null;
  try { tok = await store.get("token", { type: "json" }); } catch (_) {}
  if (tok && tok.access_token && Date.now() < tok.expires_at - 60000) return tok.access_token;
  await throttle();
  const res = await fetch(`${BASE}/oauthorize/token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ grant_type: "password", username: process.env.TC_USERNAME, password: process.env.TC_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const d = await res.json();
  await store.setJSON("token", { access_token: d.access_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000 });
  return d.access_token;
}

async function tcGet(path, token) {
  await throttle();
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}
async function tcPost(path, token, body) {
  await throttle();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json();
}
// Per-club margin overrides, e.g. TC_MARGIN_OVERRIDES="Arsenal=3,Liverpool=3"
// Any fixture whose name contains the key uses that margin instead of the default.
const MARGIN_OVERRIDES = (process.env.TC_MARGIN_OVERRIDES || "")
  .split(",")
  .map((pair) => pair.split("="))
  .filter((kv) => kv.length === 2 && kv[0].trim())
  .map(([k, v]) => [k.trim().toLowerCase(), parseFloat(v)])
  .filter(([, v]) => !isNaN(v));

function marginFor(productName) {
  const n = (productName || "").toLowerCase();
  for (const [key, pct] of MARGIN_OVERRIDES) {
    if (n.includes(key)) return pct;
  }
  return MARGIN_PCT;
}

function applyMargin(cost, productName) {
  const pct = marginFor(productName);
  const step = ROUND_TO > 0 ? ROUND_TO : 1;
  return Math.ceil((cost * (1 + pct / 100)) / step) * step;
}

// The product list endpoint doesn't return currency, and fetching per-product
// detail would blow the rate limit — so map competition -> currency.
const COMPETITION_CURRENCY = {
  401: "GBP", // English Premier League
  405: "EUR", // La Liga
  407: "EUR", // Ligue 1
  410: "EUR", // Serie A
  409: "EUR", // Champions League
};
function currencyFor(competition) {
  return COMPETITION_CURRENCY[competition] || "GBP";
}
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  async function run() { while (i < items.length) { const idx = i++; out[idx] = await worker(items[idx]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

// Refresh the product list (all competitions) — the hourly job.
async function refreshProducts(store, token) {
  const first = await tcGet(`/product?page[number]=1`, token);
  const lastPage = (first.meta && first.meta.last_page) || 1;
  let products = [...(first.data || [])];
  if (lastPage > 1) {
    const pages = await mapLimit(
      Array.from({ length: lastPage - 1 }, (_, k) => k + 2), CONCURRENCY,
      (p) => tcGet(`/product?page[number]=${p}`, token)
    );
    for (const d of pages) products.push(...(d.data || []));
  }
  const slim = products
    .filter((p) => p.match && p.match.start && p.match.start.utc)
    .map((p) => ({ id: p.id, name: p.name, slug: p.slug,
                   competition: p.match.competition,
                   currency: currencyFor(p.match.competition),
                   venue: p.venue,
                   date: p.match.start.local, utc: p.match.start.utc }));
  await store.setJSON("products", { ts: Date.now(), list: slim });

  // Venue reference data (name, address, coordinates) — static, so cache it once
  // and only ever fetch venues we don't already hold. Capped per run to protect
  // the rate limit.
  try {
    let venues = null;
    try { venues = await store.get("venues", { type: "json" }); } catch (_) {}
    const byId = (venues && venues.byId) || {};
    const needed = [...new Set(slim.map((p) => p.venue).filter(Boolean))]
      .filter((id) => !byId[id])
      .slice(0, 25);
    if (needed.length) {
      const fetched = await mapLimit(needed, 4, async (id) => {
        try {
          const d = await tcGet(`/venues/${id}`, token);
          const v = d.data || {};
          return [id, { name: v.name, address: v.address, city: v.city,
                        lat: v.coordinates?.lat, lng: v.coordinates?.lng }];
        } catch (_) { return null; }
      });
      for (const row of fetched) if (row) byId[row[0]] = row[1];
      await store.setJSON("venues", { ts: Date.now(), byId });
    }
  } catch (_) {}

  return slim;
}

// Refresh prices for the known product list — the per-minute job.
async function refreshPrices(store, products) {
  const token = await tokenFetch(store);
  const ids = products.map((p) => p.id);
  const nameById = {};
  for (const p of products) nameById[p.id] = p.name;
  const priced = {}; // id -> [{name, price, max_qty, available}]
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    let page = 1;
    for (;;) {
      const d = await tcPost("/inventory-status", token, { products: batch, page: { number: page } });
      for (const p of d.data || []) {
        priced[p.id] = (p.ticket_options || []).map((o) => ({
          name: o.name,
          cost: o.price,
          price: applyMargin(o.price, nameById[p.id]),
          max_qty: o.max_purchase_qty,
          available: o.available,
          ticket_option: o.id,
          ticket_category: o.ticket_category,
        }));
      }
      if (page >= (d.meta?.last_page || 1) || (d.data || []).length === 0) break;
      page += 1;
    }
  }
  await store.setJSON("prices", { ts: Date.now(), by_id: priced });
}

export default async () => {
  if (!MARGIN_PCT) return new Response("TC_MARGIN_PCT not set", { status: 500 });
  const store = getStore("tc-cache");
  try {
    const token = await tokenFetch(store);

    // Is the product list missing or stale (older than an hour)?
    let productsMeta = null;
    try { productsMeta = await store.get("products", { type: "json" }); } catch (_) {}
    const productsStale = !productsMeta || Date.now() - productsMeta.ts > PRODUCT_SEARCH_INTERVAL_MS;

    if (productsStale) {
      // Hourly job: refresh the product list. Skip prices this minute to stay well under the limit.
      await refreshProducts(store, token);
      return new Response("products refreshed", { status: 200 });
    } else {
      // Per-minute job: refresh prices only.
      await refreshPrices(store, productsMeta.list);
      return new Response("prices refreshed", { status: 200 });
    }
  } catch (err) {
    return new Response("poll error: " + String(err.message || err), { status: 502 });
  }
};

// Run every minute.
export const config = { schedule: "* * * * *" };
