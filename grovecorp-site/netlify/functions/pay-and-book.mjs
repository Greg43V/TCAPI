// netlify/functions/pay-and-book.mjs
// Takes a Sola single-use token (SUT) from the card form, charges the card,
// and ONLY on approval runs the proven TC reserve->confirm to create the order.
//
// STAGE 1 (current): TEST_MODE=1 uses cc:save (tokenise, NO money charged) so we
// can prove the whole flow for £0. Switch to cc:sale (real charge) only after
// this stage passes.
//
// Env vars needed:
//   SOLA_XKEY        - secret Sola API key (charges cards) — in Netlify
//   SOLA_TEST_MODE   - "1" => cc:save (no charge); "0"/unset later => cc:sale
//   TC_USERNAME / TC_PASSWORD / TC_BASE - existing TC creds
//   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID - existing alerts

const SOLA_URL = "https://x1.cardknox.com/gatewayJSON";
const TC_BASE = process.env.TC_BASE || "https://api-sandbox.travelconnectionleisure.com/v1";
const TEST_MODE = (process.env.SOLA_TEST_MODE ?? "1") === "1"; // default SAFE (no charge)

function tg(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) return Promise.resolve();
  return fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
  }).catch(() => {});
}

async function tcToken() {
  const r = await fetch(`${TC_BASE}/oauthorize/token`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ grant_type: "password", username: process.env.TC_USERNAME, password: process.env.TC_PASSWORD }),
  });
  if (!r.ok) throw new Error("tc auth " + r.status);
  return (await r.json()).access_token;
}

export default async (req) => {
  const H = { "content-type": "application/json" };
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: H });

  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers: H }); }

  const {
    sut,                 // single-use token from iFields (card)
    cvv_token,           // single-use token from iFields (cvv)
    amount,              // charge amount (USD) — what the customer agreed to
    ticket_option,       // TC ticket_option id
    quantity,            // number of tickets
    first_name, last_name, email, phone,
    event_label,         // human label for alerts
  } = body || {};

  // ---- validate ----
  if (!sut) return new Response(JSON.stringify({ error: "missing card token" }), { status: 400, headers: H });
  const amt = Number(amount);
  if (!amt || amt <= 0) return new Response(JSON.stringify({ error: "bad amount" }), { status: 400, headers: H });
  if (!ticket_option || !quantity) return new Response(JSON.stringify({ error: "missing ticket details" }), { status: 400, headers: H });
  if (!first_name || !email) return new Response(JSON.stringify({ error: "missing buyer details" }), { status: 400, headers: H });

  const xKey = process.env.SOLA_XKEY;
  if (!xKey) return new Response(JSON.stringify({ error: "server not configured" }), { status: 500, headers: H });

  const invoice = "BLX-" + Date.now(); // unique, for Sola duplicate protection

  // ---- 1) CHARGE (or cc:save in test mode) ----
  const command = TEST_MODE ? "cc:save" : "cc:sale";
  const solaReq = {
    xKey, xVersion: "5.0.0",
    xSoftwareName: "BucketListExp", xSoftwareVersion: "1.0",
    xCommand: command,
    xCardNum: sut,               // SUT from iFields (card number)
    xCVV: cvv_token || "",       // SUT from iFields (cvv)
    xCardType: "",               // gateway infers
    xName: `${first_name} ${last_name || ""}`.trim(),
    xEmail: email,
    xInvoice: invoice,
    xCurrency: "USD",
  };
  if (!TEST_MODE) { solaReq.xAmount = amt.toFixed(2); } // amount only matters for a real sale

  let sola;
  try {
    const r = await fetch(SOLA_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(solaReq),
    });
    sola = await r.json().catch(() => ({}));
  } catch (e) {
    return new Response(JSON.stringify({ error: "payment gateway unreachable" }), { status: 502, headers: H });
  }

  const approved = sola.xResult === "A";
  if (!approved) {
    // payment failed — NO TC order is created
    await tg(`❌ PAYMENT FAILED\n${event_label || ""}\n${first_name} ${last_name || ""}\n${sola.xError || sola.xStatus || "declined"} (ref ${sola.xRefNum || "n/a"})`);
    return new Response(JSON.stringify({ ok: false, stage: "payment", error: sola.xError || "Your card was declined. Please try another card." }), { status: 200, headers: H });
  }

  // ---- 2) PAYMENT OK -> create the TC order (reserve then confirm) ----
  let tcOrder = null, tcErr = null, holdNum = null;
  try {
    const t = await tcToken();
    // reserve
    const rr = await fetch(`${TC_BASE}/reservations`, {
      method: "POST", headers: { authorization: `Bearer ${t}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ agent_reference: invoice, products: [{ ticket_option, quantity }] }),
    });
    const rj = await rr.json().catch(() => ({}));
    if (!rr.ok || !rj?.data?.reservation_num) throw new Error("reserve failed: " + JSON.stringify(rj).slice(0, 300));
    holdNum = rj.data.reservation_num;
    // confirm — one guest per ticket, lead = buyer
    const guests = [];
    for (let i = 0; i < quantity; i++) {
      guests.push({ first_name: i === 0 ? first_name : "Guest", last_name: i === 0 ? (last_name || "Booking") : String(i + 1), ticket_option_id: ticket_option, lead: i === 0 });
    }
    const cr = await fetch(`${TC_BASE}/reservations/${holdNum}/confirm`, {
      method: "POST", headers: { authorization: `Bearer ${t}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ guests }),
    });
    const cj = await cr.json().catch(() => ({}));
    if (!cr.ok) throw new Error("confirm failed: " + JSON.stringify(cj).slice(0, 300));
    tcOrder = cj.order || cj.data || {};
  } catch (e) {
    tcErr = String(e && e.message || e);
  }

  // ---- 3) alert + respond ----
  if (tcOrder) {
    await tg(
      `${TEST_MODE ? "🧪 TEST (no charge)" : "✅ PAID"} + ORDER\n` +
      `${event_label || ""}\n${first_name} ${last_name || ""} — ${quantity} ticket(s)\n` +
      `Charge: ${TEST_MODE ? "£0 (cc:save)" : "$" + amt.toFixed(2)} (ref ${sola.xRefNum})\n` +
      `TC order: ${tcOrder.order_no || tcOrder.order_num || holdNum}`
    );
    return new Response(JSON.stringify({ ok: true, test_mode: TEST_MODE, order_no: tcOrder.order_no || tcOrder.order_num || holdNum, payment_ref: sola.xRefNum }), { status: 200, headers: H });
  } else {
    // PAYMENT SUCCEEDED BUT TC FAILED — needs manual resolution (refund or manual confirm)
    await tg(
      `⚠️ ${TEST_MODE ? "TEST: " : ""}PAID BUT TC ORDER FAILED — ACTION NEEDED\n` +
      `${event_label || ""}\n${first_name} ${last_name || ""} — ${quantity} ticket(s)\n` +
      `Payment ref ${sola.xRefNum} (${TEST_MODE ? "no real charge" : "$" + amt.toFixed(2) + " CHARGED"})\n` +
      `Hold: ${holdNum || "none"}\nError: ${tcErr}`
    );
    return new Response(JSON.stringify({ ok: false, stage: "confirm", payment_ref: sola.xRefNum, hold: holdNum, error: "Payment received but booking needs manual confirmation — we'll be in touch immediately." }), { status: 200, headers: H });
  }
};
