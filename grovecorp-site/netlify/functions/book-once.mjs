// TEMPORARY one-shot: reserve a fresh hold then confirm -> real order.
// Parameterised for multiple orders (Chelsea v Luton WestView).
// Usage: /.netlify/functions/book-once?opt=<id>&qty=<n>&fn=<first>&ln=<last>&key=BLX-confirm-8834
// DELETE after use. Creates a REAL order + invoice each run.
const BASE = process.env.TC_BASE || "https://api-sandbox.travelconnectionleisure.com/v1";
const GUARD = "BLX-confirm-8834";

async function token() {
  const r = await fetch(`${BASE}/oauthorize/token`, {
    method:"POST", headers:{ "content-type":"application/json", accept:"application/json" },
    body: JSON.stringify({ grant_type:"password", username:process.env.TC_USERNAME, password:process.env.TC_PASSWORD }),
  });
  if (!r.ok) throw new Error("auth failed: " + r.status);
  return (await r.json()).access_token;
}

export default async (req) => {
  const u = new URL(req.url);
  const opt = parseInt(u.searchParams.get("opt"), 10);
  const qty = parseInt(u.searchParams.get("qty") || "1", 10);
  const fn  = (u.searchParams.get("fn") || "Guest").trim();
  const ln  = (u.searchParams.get("ln") || "Booking").trim();
  const key = u.searchParams.get("key");
  const out = []; const line = (x) => out.push(x);

  if (key !== GUARD) return new Response("forbidden", { status: 403 });
  if (!opt) return new Response("add ?opt=<ticket_option_id>&qty=&fn=&ln=&key=", { status: 400 });

  line("ticket_option: " + opt + " | qty: " + qty + " | lead: " + fn + " " + ln);
  try {
    const t = await token();
    line("auth: ok");

    // 1) RESERVE
    const rRes = await fetch(`${BASE}/reservations`, {
      method:"POST",
      headers:{ authorization:`Bearer ${t}`, accept:"application/json", "content-type":"application/json" },
      body: JSON.stringify({ agent_reference: "BLX-"+ln, products: [{ ticket_option: opt, quantity: qty }] }),
    });
    line("POST /reservations status: " + rRes.status);
    const rj = await rRes.json().catch(() => ({}));
    if (!rRes.ok || !rj?.data?.reservation_num) {
      line("reserve response: " + JSON.stringify(rj).slice(0, 1200));
      line("\n❌ reserve failed — no order created.");
      return new Response(out.join("\n"), { headers:{ "content-type":"text/plain" } });
    }
    const num = rj.data.reservation_num;
    line("✅ held: " + num + " | price_total: " + rj.data.price_total + " " + (rj.data.currency||"") + " | expires: " + rj.data.expires_at);

    // 2) CONFIRM — one guest per ticket, lead = the named buyer
    const guests = [];
    for (let i = 0; i < qty; i++) {
      guests.push({
        first_name: i === 0 ? fn : "Guest",
        last_name:  i === 0 ? ln : String(i + 1),
        ticket_option_id: opt,
        lead: i === 0,
      });
    }
    const cRes = await fetch(`${BASE}/reservations/${num}/confirm`, {
      method:"POST",
      headers:{ authorization:`Bearer ${t}`, accept:"application/json", "content-type":"application/json" },
      body: JSON.stringify({ guests }),
    });
    line("POST /confirm status: " + cRes.status);
    const cj = await cRes.json().catch(() => ({}));
    line("confirm response: " + JSON.stringify(cj).slice(0, 1200));

    if (cRes.ok) {
      const o = cj.order || cj.data || {};
      line("\n✅✅ ORDER CREATED for " + fn + " " + ln);
      line("order_no: " + (o.order_no || o.order_num || num));
      line("total: " + (o.total || "") + " " + (o.currency || ""));
      line("status: " + (o.status || ""));
    } else {
      line("\n❌ confirm failed — hold " + num + " placed but NOT confirmed. Fix + retry, or confirm " + num + " in the Hub.");
    }
  } catch (e) {
    line("ERROR: " + String(e && e.message || e));
  }
  return new Response(out.join("\n"), { headers:{ "content-type":"text/plain" } });
};
