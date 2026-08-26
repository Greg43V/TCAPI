// TEMP diagnostic: shows what the RUNNING function actually sees — env margins + cache state.
// /.netlify/functions/pricecheck  — DELETE after use.
import { getStore } from "@netlify/blobs";
export default async (req) => {
  const out = {};
  out.deployed_marker = "DEPLOY-TEST-v3"; // proves whether the latest code is live
  out.env = {
    TC_MARGIN_PCT: process.env.TC_MARGIN_PCT ?? "(unset)",
    TC_ROUND_TO: process.env.TC_ROUND_TO ?? "(unset)",
    TC_MARGIN_OVERRIDES: process.env.TC_MARGIN_OVERRIDES ?? "(unset)",
  };
  try {
    const store = getStore("tc-cache");
    const prices = await store.get("prices", { type: "json" }).catch(() => null);
    const products = await store.get("products", { type: "json" }).catch(() => null);
    out.cache = {
      prices_ts: prices ? prices.ts : "(no prices blob)",
      prices_ts_readable: prices && prices.ts ? new Date(prices.ts).toISOString() : "(none)",
      products_count: products && products.list ? products.list.length : "(no products blob)",
      blob_store_ok: true,
    };
    // show what margin WOULD apply to an Arsenal-named product right now
    const MARGIN_PCT = parseFloat(process.env.TC_MARGIN_PCT || "0");
    const OV = (process.env.TC_MARGIN_OVERRIDES || "").split(",").map(x=>x.split("=")).filter(k=>k.length===2).map(([k,v])=>[k.trim().toLowerCase(),parseFloat(v)]);
    let arsenalMargin = MARGIN_PCT;
    for (const [k,pct] of OV) if ("arsenal v brighton".includes(k)) arsenalMargin = pct;
    out.computed = { default_margin_pct: MARGIN_PCT, arsenal_would_get_pct: arsenalMargin };
  } catch (e) {
    out.cache = { blob_store_ok: false, error: String(e && e.message || e) };
  }

  // Live inventory probe for a given product (?product=18797)
  try {
    const pid = parseInt(new URL(req.url).searchParams.get("product") || "0", 10);
    if (pid) {
      const BASE = process.env.TC_BASE || "https://api-sandbox.travelconnectionleisure.com/v1";
      const tr = await fetch(`${BASE}/oauthorize/token`, { method:"POST", headers:{ "content-type":"application/json", accept:"application/json" }, body: JSON.stringify({ grant_type:"password", username:process.env.TC_USERNAME, password:process.env.TC_PASSWORD }) });
      const tok = (await tr.json()).access_token;
      const ir = await fetch(`${BASE}/inventory-status`, { method:"POST", headers:{ authorization:`Bearer ${tok}`, accept:"application/json", "content-type":"application/json" }, body: JSON.stringify({ products:[pid], page:{ number:1 } }) });
      const ij = await ir.json();
      const row = (ij.data||[]).find(x=>x.id===pid) || (ij.data||[])[0];
      const MARGIN_PCT = parseFloat(process.env.TC_MARGIN_PCT || "0");
      const ROUND_TO = parseFloat(process.env.TC_ROUND_TO || "1");
      out.live_inventory = (row && row.ticket_options ? row.ticket_options : []).slice(0,3).map(o => ({
        name:o.name, RAW_cost:o.price, available:o.available,
        computed_15pct: Math.ceil((o.price*1.15)/ROUND_TO)*ROUND_TO
      }));
    }
  } catch(e) { out.live_inventory_error = String(e&&e.message||e); }

  return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json" } });
};
