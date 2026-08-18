// TEMPORARY one-time confirm — proves the TC confirm→order path on a real, paid reservation.
// Open: /.netlify/functions/confirm-once?num=O345273&key=BLX-confirm-8834
// DELETE this function immediately after use.
const BASE = process.env.TC_BASE || "https://api-sandbox.travelconnectionleisure.com/v1";
const GUARD = "BLX-confirm-8834"; // simple guard so a random visitor can't trigger it

async function token() {
  const r = await fetch(`${BASE}/oauthorize/token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ grant_type: "password", username: process.env.TC_USERNAME, password: process.env.TC_PASSWORD }),
  });
  if (!r.ok) throw new Error("auth failed: " + r.status);
  return (await r.json()).access_token;
}

export default async (req) => {
  const u = new URL(req.url);
  const num = u.searchParams.get("num");
  const key = u.searchParams.get("key");
  const out = [];
  const line = (x) => out.push(x);

  if (key !== GUARD) return new Response("forbidden", { status: 403 });
  if (!num) return new Response("add ?num=<reservation> &key=", { status: 400 });

  line("BASE: " + BASE);
  line("reservation: " + num);
  try {
    const t = await token();
    line("auth: ok");

    // 1) look up the reservation first, so we can see status + the ticket_option ids to attach guests to
    const look = await fetch(`${BASE}/reservations/${num}`, { headers: { authorization: `Bearer ${t}`, accept: "application/json" } });
    line("GET reservation status: " + look.status);
    let resv = null;
    try { resv = (await look.json()).data; } catch (_) {}
    if (resv) {
      line("  reservation status: " + resv.status);
      line("  expires_at: " + resv.expires_at);
      line("  price_total: " + resv.price_total + " " + (resv.currency || ""));
      const prods = resv.products || [];
      line("  products/options: " + JSON.stringify(prods.map(p => ({ id: p.id, opt: p.ticket_option, qty: p.quantity, name: p.name }))));
    }

    // 2) build guests array — lead on the first ticket option, one guest per ticket
    // We attach the lead guest to each ticket; TC requires a guest per ticket in many cases.
    const lead = { first_name: "Athol", last_name: "Chiert", lead: true };
    // Determine the ticket_option id and quantity from the reservation
    let opt = null, qty = 0;
    if (resv && resv.products && resv.products[0]) {
      opt = resv.products[0].ticket_option;
      qty = resv.products[0].quantity || 4;
    }
    const guests = [];
    for (let i = 0; i < (qty || 4); i++) {
      guests.push({
        first_name: i === 0 ? "Athol" : "Guest",
        last_name: i === 0 ? "Chiert" : String(i + 1),
        ticket_option_id: opt,
        lead: i === 0,
      });
    }
    line("  confirming with guests: " + JSON.stringify(guests));

    // 3) confirm
    const conf = await fetch(`${BASE}/reservations/${num}/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${t}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ guests }),
    });
    line("POST confirm status: " + conf.status);
    const cj = await conf.json().catch(() => ({}));
    line("confirm response: " + JSON.stringify(cj).slice(0, 1500));

    if (conf.ok) {
      const o = cj.data || {};
      line("");
      line("✅ ORDER CREATED");
      line("order_num: " + (o.order_num || o.reservation_num || "(see response above)"));
      line("status: " + (o.status || ""));
    } else {
      line("");
      line("❌ confirm failed — see status + response above (likely expired hold or guest format).");
    }
  } catch (e) {
    line("ERROR: " + String(e && e.message || e));
  }
  return new Response(out.join("\n"), { headers: { "content-type": "text/plain" } });
};
