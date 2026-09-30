// netlify/functions/tc-fixtures.mjs
// Premier League (401) fixtures + LIVE prices. Fetches from TC and caches in the
// blob store for 5 min. Replaces the old poller-cache read, whose price blob has
// been frozen — so front-page tiles now match the live event-page prices.

import { getStore } from "@netlify/blobs";

const BASE = process.env.TC_BASE || "https://api-sandbox.travelconnectionleisure.com/v1";
const MARGIN_PCT = parseFloat(process.env.TC_MARGIN_PCT || "0");
const ROUND_TO = parseFloat(process.env.TC_ROUND_TO || "1");
const CACHE_MS = 5 * 60 * 1000; // 5 min
const ALLOWED_COMPETITIONS = [401];

const MARGIN_OVERRIDES = (process.env.TC_MARGIN_OVERRIDES || "")
  .split(",").map((p) => p.split("="))
  .filter((kv) => kv.length === 2 && kv[0].trim())
  .map(([k, v]) => [k.trim().toLowerCase(), parseFloat(v)])
  .filter(([, v]) => !isNaN(v));
function marginFor(name){ const n=(name||"").toLowerCase(); for (const [k,pct] of MARGIN_OVERRIDES) if (n.includes(k)) return pct; return MARGIN_PCT; }
function applyMargin(cost, name){ const step = ROUND_TO>0?ROUND_TO:1; return Math.ceil((cost*(1+marginFor(name)/100))/step)*step; }

function startMs(p){
  var m = p.match && p.match.start;
  if (!m) { if (p.event_dates && p.event_dates[0]) return new Date(p.event_dates[0]).getTime(); return 0; }
  if (typeof m === "string") return new Date(m).getTime();
  if (m.epoch) return m.epoch * 1000;
  if (m.utc) return new Date(m.utc).getTime();
  if (m.local) return new Date(m.local).getTime();
  return 0;
}
async function token(){
  const r = await fetch(`${BASE}/oauthorize/token`, {
    method:"POST", headers:{ "content-type":"application/json", accept:"application/json" },
    body: JSON.stringify({ grant_type:"password", username:process.env.TC_USERNAME, password:process.env.TC_PASSWORD }),
  });
  if (!r.ok) throw new Error("auth");
  return (await r.json()).access_token;
}
async function tcGet(path, t){
  const r = await fetch(`${BASE}${path}`, { headers:{ authorization:`Bearer ${t}`, accept:"application/json" } });
  if (!r.ok) throw new Error("GET "+path+" "+r.status);
  return r.json();
}
function nameOf(list, id){ const p = list.find((x)=>x.id===id); return p ? p.name : ""; }

export default async (req) => {
  const url = new URL(req.url);
  const competition = parseInt(url.searchParams.get("competition") || "401", 10);
  const headers = { "content-type":"application/json", "cache-control":"no-store, no-cache, must-revalidate, max-age=0" };
  if (!ALLOWED_COMPETITIONS.includes(competition)) {
    return new Response(JSON.stringify({ error:"That competition is not enabled on this site." }), { status:403, headers });
  }

  const store = getStore("tc-cache");
  const cacheKey = "fixtures-live-" + competition;
  const bypass = url.searchParams.get("fresh") === "1";

  if (!bypass) {
    try {
      const c = await store.get(cacheKey, { type:"json" });
      if (c && Date.now() - c.ts < CACHE_MS) {
        return new Response(JSON.stringify({ competition, count:c.fixtures.length, fixtures:c.fixtures, cached:true }), { status:200, headers });
      }
    } catch (_) {}
  }

  try {
    const t = await token();
    let page = 1, products = [];
    while (page <= 8) {
      const d = await tcGet(`/product?competition=${competition}&page[number]=${page}`, t);
      const list = d.data || [];
      products.push(...list);
      if (page >= (d.meta?.last_page || 1) || list.length === 0) break;
      page += 1;
    }
    const now = Date.now();
    const upcoming = products.filter((p) => startMs(p) > now);

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
          if (opts.length) priceById[p.id] = Math.min(...opts.map((o) => applyMargin(o.price, nameOf(upcoming, p.id))));
          else priceById[p.id] = null;
        }
        if (pageN >= (d.meta?.last_page || 1) || (d.data||[]).length === 0) break;
        pageN += 1;
      }
    }

    const fixtures = upcoming.map((p) => {
      const start = (p.match && p.match.start) ? (p.match.start.utc || p.match.start.local) : (p.event_dates && p.event_dates[0]) || null;
      const from = priceById[p.id];
      return {
        id: p.id, name: p.name, date: start, currency: "GBP", // PL is always England => GBP
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
