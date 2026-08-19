// netlify/functions/comp-fixtures.mjs
// ON-DEMAND fixtures + prices for ANY competition (except 401, which the poller
// serves via tc-fixtures). Fetches from TC when a competition page is visited,
// then caches so repeat visits are free. Empty competitions cache too (so we
// don't refetch nothing every time).

import { getStore } from "@netlify/blobs";

const BASE = process.env.TC_BASE || "https://api-sandbox.travelconnectionleisure.com/v1";
const MARGIN_PCT = parseFloat(process.env.TC_MARGIN_PCT || "0");
const ROUND_TO = parseFloat(process.env.TC_ROUND_TO || "1");
const CACHE_MS = 30 * 60 * 1000; // 30 min, matches the poller cadence

const MARGIN_OVERRIDES = (process.env.TC_MARGIN_OVERRIDES || "")
  .split(",").map((p) => p.split("="))
  .filter((kv) => kv.length === 2 && kv[0].trim())
  .map(([k, v]) => [k.trim().toLowerCase(), parseFloat(v)])
  .filter(([, v]) => !isNaN(v));
function marginFor(name) {
  const n = (name || "").toLowerCase();
  for (const [k, pct] of MARGIN_OVERRIDES) if (n.includes(k)) return pct;
  return MARGIN_PCT;
}
function applyMargin(cost, name) {
  const step = ROUND_TO > 0 ? ROUND_TO : 1;
  return Math.ceil((cost * (1 + marginFor(name) / 100)) / step) * step;
}
const COMPETITION_CURRENCY = { 401:"GBP",405:"EUR",406:"EUR",407:"EUR",408:"EUR",409:"EUR",410:"EUR",412:"EUR",426:"EUR",433:"EUR",434:"EUR",440:"EUR",442:"EUR",443:"EUR" };
function currencyFor(c){ return COMPETITION_CURRENCY[c] || "GBP"; }

async function token() {
  const r = await fetch(`${BASE}/oauthorize/token`, {
    method:"POST", headers:{ "content-type":"application/json", accept:"application/json" },
    body: JSON.stringify({ grant_type:"password", username:process.env.TC_USERNAME, password:process.env.TC_PASSWORD }),
  });
  if (!r.ok) throw new Error("auth");
  return (await r.json()).access_token;
}
async function tcGet(path, t) {
  const r = await fetch(`${BASE}${path}`, { headers:{ authorization:`Bearer ${t}`, accept:"application/json" } });
  if (!r.ok) throw new Error("GET "+path+" "+r.status);
  return r.json();
}

export default async (req) => {
  const url = new URL(req.url);
  const competition = parseInt(url.searchParams.get("competition") || "0", 10);
  const headers = { "content-type":"application/json", "cache-control":"public, max-age=120" };
  if (!competition) return new Response(JSON.stringify({ error:"missing competition" }), { status:400, headers });
  if (competition === 401) return new Response(JSON.stringify({ error:"use tc-fixtures for 401" }), { status:400, headers });

  const store = getStore("tc-cache");
  const cacheKey = "comp-" + competition;

  // serve cache if fresh
  try {
    const c = await store.get(cacheKey, { type:"json" });
    if (c && Date.now() - c.ts < CACHE_MS) {
      return new Response(JSON.stringify({ competition, count:c.fixtures.length, fixtures:c.fixtures, cached:true }), { status:200, headers });
    }
  } catch (_) {}

  // fetch fresh from TC
  try {
    const t = await token();
    const cur = currencyFor(competition);

    // page through products for this competition
    let page = 1, products = [];
    while (page <= 6) {
      const d = await tcGet(`/product?competition=${competition}&page[number]=${page}`, t);
      const list = d.data || [];
      products.push(...list);
      if (page >= (d.meta?.last_page || 1) || list.length === 0) break;
      page += 1;
    }

    const now = Date.now();
    // upcoming only
    const upcoming = products.filter((p) => {
      const start = p.match?.start ? new Date(p.match.start).getTime() : (p.event_dates?.[0] ? new Date(p.event_dates[0]).getTime() : 0);
      return start > now;
    });

    // price them (batch through inventory-status, 10 at a time)
    const priceById = {};
    const ids = upcoming.map((p) => p.id);
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      let pageN = 1;
      while (pageN <= 4) {
        const r = await fetch(`${BASE}/inventory-status`, {
          method:"POST", headers:{ authorization:`Bearer ${t}`, accept:"application/json", "content-type":"application/json" },
          body: JSON.stringify({ products: batch, page:{ number: pageN } }),
        });
        if (!r.ok) break;
        const d = await r.json();
        for (const p of d.data || []) {
          const opts = (p.ticket_options || []).filter((o) => o.available);
          if (opts.length) {
            const min = Math.min(...opts.map((o) => applyMargin(o.price, nameOf(upcoming, p.id))));
            priceById[p.id] = min;
          } else {
            priceById[p.id] = null; // sold out
          }
        }
        if (pageN >= (d.meta?.last_page || 1) || (d.data||[]).length === 0) break;
        pageN += 1;
      }
    }

    const fixtures = upcoming.map((p) => {
      const start = p.match?.start || p.event_dates?.[0] || null;
      const from = priceById[p.id];
      return {
        id: p.id, name: p.name, date: start, currency: cur,
        from: (from === undefined ? null : from),
        sold_out: from === null,
        priced: from !== undefined,
      };
    }).sort((a,b) => new Date(a.date) - new Date(b.date));

    await store.setJSON(cacheKey, { ts: Date.now(), fixtures });
    return new Response(JSON.stringify({ competition, count: fixtures.length, fixtures }), { status:200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error:"fetch failed", detail:String(e&&e.message||e), fixtures:[] }), { status:200, headers });
  }
};

function nameOf(list, id){ const p = list.find((x)=>x.id===id); return p ? p.name : ""; }
