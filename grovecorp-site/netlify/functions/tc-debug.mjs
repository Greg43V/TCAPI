// netlify/functions/tc-debug.mjs
// TEMPORARY diagnostic. Open /.netlify/functions/tc-debug in a browser.
// It reports, in plain text, exactly which step fails and why. Delete after use.

import { getStore } from "@netlify/blobs";

export default async () => {
  const out = [];
  const line = (s) => out.push(s);

  line("== env check ==");
  line("TC_BASE: " + (process.env.TC_BASE || "(unset -> sandbox default)"));
  line("TC_USERNAME set: " + !!process.env.TC_USERNAME);
  line("TC_PASSWORD set: " + !!process.env.TC_PASSWORD);
  line("TC_MARGIN_PCT: " + (process.env.TC_MARGIN_PCT || "(unset!)"));
  line("");

  line("== blobs check ==");
  let store;
  try {
    store = getStore("tc-cache");
    await store.setJSON("debug-write", { t: Date.now() });
    const back = await store.get("debug-write", { type: "json" });
    line("blobs OK — wrote & read back: " + JSON.stringify(back));
  } catch (e) {
    line("BLOBS FAILED: " + String(e && e.message || e));
    line("(This is the problem — the poller can't store prices.)");
    return new Response(out.join("\n"), { headers: { "content-type": "text/plain" } });
  }
  line("");

  line("== auth check ==");
  const BASE = process.env.TC_BASE || "https://api-sandbox.travelconnectionleisure.com/v1";
  let token;
  try {
    const r = await fetch(`${BASE}/oauthorize/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ grant_type: "password", username: process.env.TC_USERNAME, password: process.env.TC_PASSWORD }),
    });
    line("auth HTTP status: " + r.status);
    const j = await r.json();
    token = j.access_token;
    line("got token: " + (token ? "yes" : "NO — " + JSON.stringify(j)));
  } catch (e) {
    line("AUTH FAILED: " + String(e && e.message || e));
    return new Response(out.join("\n"), { headers: { "content-type": "text/plain" } });
  }
  line("");

  line("== product search check ==");
  try {
    const r = await fetch(`${BASE}/product?page[number]=1`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    line("product HTTP status: " + r.status);
    const j = await r.json();
    line("products on page 1: " + ((j.data && j.data.length) || 0) + ", total pages: " + ((j.meta && j.meta.last_page) || "?"));
  } catch (e) {
    line("PRODUCT SEARCH FAILED: " + String(e && e.message || e));
  }

  line("");
  line("== done ==");
  return new Response(out.join("\n"), { headers: { "content-type": "text/plain" } });
};
