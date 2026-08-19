// netlify/functions/competitions.mjs
// Returns TC's competition list, each flagged with whether it currently has
// upcoming fixtures — so the events hub can hide empty ones. Cached 6h.
import { getStore } from "@netlify/blobs";

const BASE = process.env.TC_BASE || "https://api-sandbox.travelconnectionleisure.com/v1";
const CACHE_MS = 6 * 60 * 60 * 1000;

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
  if (!r.ok) throw new Error(path+" "+r.status);
  return r.json();
}

export default async (req) => {
  const headers = { "content-type":"application/json", "cache-control":"public, max-age=600" };
  const store = getStore("tc-cache");
  try {
    const c = await store.get("competitions-index", { type:"json" });
    if (c && Date.now() - c.ts < CACHE_MS) {
      return new Response(JSON.stringify({ competitions:c.competitions, cached:true }), { status:200, headers });
    }
  } catch (_) {}

  try {
    const t = await token();
    const list = (await tcGet(`/competitions`, t)).data || [];
    const now = Date.now();
    // check each competition for at least one upcoming product (page 1 only — cheap)
    const out = [];
    for (const comp of list) {
      let has = false;
      try {
        const d = await tcGet(`/product?competition=${comp.id}&page[number]=1`, t);
        has = (d.data || []).some((p) => {
          const m = p.match && p.match.start;
          let start = 0;
          if (m) start = m.epoch ? m.epoch*1000 : (m.utc ? new Date(m.utc).getTime() : (m.local ? new Date(m.local).getTime() : 0));
          else if (p.event_dates && p.event_dates[0]) start = new Date(p.event_dates[0]).getTime();
          return start > now;
        });
      } catch (_) {}
      out.push({ id: comp.id, name: comp.name, has_fixtures: has });
    }
    await store.setJSON("competitions-index", { ts: Date.now(), competitions: out });
    return new Response(JSON.stringify({ competitions: out }), { status:200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error:"failed", detail:String(e&&e.message||e), competitions:[] }), { status:200, headers });
  }
};
