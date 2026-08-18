// TEMPORARY one-shot: reserve a fresh hold then immediately confirm -> real order.
// For the paid buyer (Athol Chiert), Man Utd v Man City (product 18766).
// Usage: /.netlify/functions/book-once?opt=<ticket_option_id>&qty=4&key=BLX-confirm-8834
// DELETE after use. Creates a REAL order + invoice.
const BASE = process.env.TC_BASE || "https://api-sandbox.travelconnectionleisure.com/v1";
const GUARD = "BLX-confirm-8834";

async function token() {
  const r = await fetch(`${BASE}/oauthorize/token`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ grant_type: "password", username: process.env.TC_USERNAME, password: process.env.TC_PASSWORD }),
  });
  if (!r.ok) throw new Error("auth failed: " + r.status);
  return (await r.json()).access_token;
}

export default async (req) => {
  const u = new URL(req.url);
  const opt = parseInt(u.searchParams.get("opt"), 10);
  const qty = parseInt(u.searchParams.get("qty") || "4", 10);
  const key = u.searchParams.get("key");
  const out = []; const line = (x) => out.push(x);

  if (key !== GUARD) return new Response("forbidden", { status: 403 });
  if (!opt) return new Response("add ?opt=<ticket_option_id>&qty=4&key=", { status: 400 });

  line("BASE: " + BASE);
  line("ticket_option: " + opt + " | qty: " + qty);
  try {
    const t = await token();
    line("auth: ok");

    // 1) RESERVE a fresh hold
    const rRes = await fetch(`${BASE}/reservations`, {
      method: "POST",
      headers: { authorization: `Bearer ${t}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ agent_reference: "BLX-Athol-MUFC", products: [{ ticket_option: opt, quantity: qty }] }),
    });
    line("POST /reservations status: " + rRes.status);
    const rj = await rRes.json().catch(() => ({}));
    if (!rRes.ok || !rj?.data?.reservation_num) {
      line("reserve response: " + JSON.stringify(rj).slice(0, 1200));
      line("");
      line("❌ reserve failed — cannot confirm. See response above.");
      return new Response(out.join("\n"), { headers: { "content-type": "text/plain" } });
    }
    const num = rj.data.reservation_num;
    line("✅ held: " + num + " | price_total: " + rj.data.price_total + " " + (rj.data.currency || "") + " | expires: " + rj.data.expires_at);

    // 2) CONFIRM immediately, guest per ticket, lead = Athol
    const guests = [];
    for (let i = 0; i < qty; i++) {
      guests.push({
        first_name: i === 0 ? "Athol" : "Guest",
        last_name: i === 0 ? "Chiert" : String(i + 1),
        ticket_option_id: opt,
        lead: i === 0,
      });
    }
    const cRes = await fetch(`${BASE}/reservations/${num}/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${t}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ guests }),
    });
    line("POST /confirm status: " + cRes.status);
    const cj = await cRes.json().catch(() => ({}));
    line("confirm response: " + JSON.stringify(cj).slice(0, 1500));

    if (cRes.ok) {
      const o = cj.data || {};
      line("");
      line("✅✅ ORDER CREATED");
      line("order_num: " + (o.order_num || o.reservation_num || num));
      line("status: " + (o.status || ""));
    } else {
      line("");
      line("❌ confirm failed — the hold " + num + " is placed but NOT confirmed. Fix guest format and retry, or confirm " + num + " in the Hub.");
    }
  } catch (e) {
    line("ERROR: " + String(e && e.message || e));
  }
  return new Response(out.join("\n"), { headers: { "content-type": "text/plain" } });
};
