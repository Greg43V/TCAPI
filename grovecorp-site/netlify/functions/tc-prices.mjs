// netlify/functions/tc-prices.mjs
// Serves full category detail for one or more events by READING THE CACHE.
// Zero live TC calls. Falls back to "warming" if the poller hasn't run yet.

import { getStore } from "@netlify/blobs";

const BASE = process.env.TC_BASE || "https://api-sandbox.travelconnectionleisure.com/v1";
const MARGIN_PCT = parseFloat(process.env.TC_MARGIN_PCT || "0");
const ROUND_TO = parseFloat(process.env.TC_ROUND_TO || "1");
const MARGIN_OVERRIDES = (process.env.TC_MARGIN_OVERRIDES || "").split(",").map((x)=>x.split("=")).filter((kv)=>kv.length===2&&kv[0].trim()).map(([k,v])=>[k.trim().toLowerCase(),parseFloat(v)]).filter(([,v])=>!isNaN(v));
function marginFor(name){ const n=(name||"").toLowerCase(); for(const [k,pct] of MARGIN_OVERRIDES) if(n.includes(k)) return pct; return MARGIN_PCT; }
function applyMargin(cost,name){ const step=ROUND_TO>0?ROUND_TO:1; return Math.ceil((cost*(1+marginFor(name)/100))/step)*step; }
function startIso(m){ var st=m&&m.start; if(!st) return null; if(typeof st==="string") return st; return st.utc||st.local||null; }
let _tok = null, _tokExp = 0;
async function token() {
  if (_tok && Date.now() < _tokExp) return _tok;
  const r = await fetch(`${BASE}/oauthorize/token`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ grant_type: "password", username: process.env.TC_USERNAME, password: process.env.TC_PASSWORD }),
  });
  if (!r.ok) throw new Error("auth");
  const j = await r.json(); _tok = j.access_token; _tokExp = Date.now() + 3000 * 1000; return _tok;
}
async function venueById(vid, t, store) {
  if (!vid) return null;
  try {
    const c = await store.get("venue-" + vid, { type: "json" });
    if (c && Date.now() - c.at < 30 * 24 * 3600 * 1000) return c.data;  // venues are static; cache 30d
  } catch (_) {}
  try {
    const r = await fetch(`${BASE}/venues/${vid}`, { headers: { authorization: `Bearer ${t}`, accept: "application/json" } });
    if (!r.ok) return null;
    const v = (await r.json()).data || {};
    const data = { name: v.name || null, address: v.address || null, city: v.city || null,
                   lat: v.coordinates?.lat ?? null, lng: v.coordinates?.lng ?? null,
                   seating: v.images?.seating || v.images?.stadium || null };
    try { await store.setJSON("venue-" + vid, { at: Date.now(), data }); } catch (_) {}
    return data;
  } catch (_) { return null; }
}
async function detailFor(id, store, bypass) {
  // cache the whole detail bundle (description + venue + name + options) for 6h
  if (!bypass) {
    try {
      const c = await store.get("detail-" + id, { type: "json" });
      if (c && Date.now() - c.at < 6 * 3600 * 1000 && c.data && c.data.name !== undefined) return c.data;
    } catch (_) {}
  }
  try {
    const t = await token();
    const r = await fetch(`${BASE}/product/${id}`, { headers: { authorization: `Bearer ${t}`, accept: "application/json" } });
    if (!r.ok) return null;
    const d = (await r.json()).data || {};
    const venue = await venueById(d.venue, t, store);
    const sp = d.seating_plan || {};
    // live prices for this product (so non-PL events show name + options too)
    let liveOptions = [];
    try {
      const ir = await fetch(`${BASE}/inventory-status`, {
        method: "POST", headers: { authorization: `Bearer ${t}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ products: [id], page: { number: 1 } }),
      });
      if (ir.ok) {
        const ij = await ir.json();
        const row = (ij.data || []).find((x) => x.id === id) || (ij.data || [])[0];
        if (row && Array.isArray(row.ticket_options)) {
          liveOptions = row.ticket_options.filter((o) => o.available).map((o) => ({
            name: o.name, price: applyMargin(o.price, d.name), max_qty: o.max_purchase_qty,
            ticket_option: o.id, ticket_category: o.ticket_category,
          })).sort((a, b) => a.price - b.price);
        }
      }
    } catch (_) {}
    const data = {
      description: { information: d.information || null, notes: d.notes || null, timetable: d.timetable || null },
      venue,
      seating_image: sp.image || (venue && venue.seating) || null,
      category_map: Array.isArray(sp.category_map) ? sp.category_map : null,
      name: d.name || null,
      date: startIso(d.match) || null,
      currency: d.currency || "GBP",
      options: liveOptions,
    };
    try { await store.setJSON("detail-" + id, { at: Date.now(), data }); } catch (_) {}
    return data;
  } catch (_) { return null; }
}


export default async (req) => {
  const url = new URL(req.url);
  const bypass = url.searchParams.get("fresh") === "1";
  const ids = (url.searchParams.get("products") || "")
    .split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
  const headers = { "content-type": "application/json", "cache-control": "public, max-age=60" };

  if (!ids.length) {
    return new Response(JSON.stringify({ error: "No product IDs. Use ?products=18793" }), { status: 400, headers });
  }

  const store = getStore("tc-cache");
  let products = null, prices = null, venues = null;
  try { products = await store.get("products", { type: "json" }); } catch (_) {}
  try { prices = await store.get("prices", { type: "json" }); } catch (_) {}
  try { venues = await store.get("venues", { type: "json" }); } catch (_) {}

  // products/prices may be null for non-PL events; that's fine — detailFor fetches live.
  products = products || { list: [] };
  prices = prices || { by_id: {}, ts: null };

  const meta = {};
  for (const p of products.list) meta[p.id] = p;
  const byId = prices.by_id || {};

  const out = await Promise.all(ids.map(async (id) => {
    const m = meta[id] || {};
    const cats = (byId[id] || []).filter((c) => c.available)
      .map((c) => ({ name: c.name, price: c.price, max_qty: c.max_qty, ticket_option: c.ticket_option, ticket_category: c.ticket_category }))
      .sort((a, b) => a.price - b.price);
    const detail = await detailFor(id, store, bypass);
    // Prefer poller cache (PL); fall back to live detail (any other competition).
    const options = cats.length ? cats : ((detail && detail.options) || []);
    const name = m.name || (detail && detail.name) || `Event ${id}`;
    const date = m.date || (detail && detail.date) || null;
    const currency = m.currency || (detail && detail.currency) || "GBP";
    return {
      id,
      venue: (detail && detail.venue) || null,
      seating_image: (detail && detail.seating_image) || null,
      category_map: (detail && detail.category_map) || null,
      description: (detail && detail.description) || null,
      name,
      date,
      currency,
      sold_out: options.length === 0,
      from: options.length ? options[0].price : null,
      options,
    };
  }));

  return new Response(JSON.stringify({ products: out, prices_updated: prices.ts }), { status: 200, headers });
};
