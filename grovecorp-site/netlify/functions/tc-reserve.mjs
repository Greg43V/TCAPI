// netlify/functions/tc-reserve.mjs
// Customer-facing seat HOLD. Places a reservation only — does NOT confirm it into
// an order, so no invoice is ever created by a website visitor. The agent takes
// payment and confirms manually.
//
// Env vars: TC_USERNAME, TC_PASSWORD, TC_BASE (+ optional TC_MAX_QTY, RESEND_API_KEY,
//           RESEND_FROM, ORDER_EMAIL)

import { getStore } from "@netlify/blobs";

const BASE = process.env.TC_BASE || "https://api-sandbox.travelconnectionleisure.com/v1";
const MAX_QTY = parseInt(process.env.TC_MAX_QTY || "6", 10);

async function getToken() {
  const res = await fetch(`${BASE}/oauthorize/token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ grant_type: "password", username: process.env.TC_USERNAME, password: process.env.TC_PASSWORD }),
  });
  if (!res.ok) throw new Error("auth failed");
  return (await res.json()).access_token;
}

function bad(msg, code = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }), { status: code, headers: { "content-type": "application/json" } });
}

export default async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);

  let body;
  try { body = await req.json(); } catch { return bad("Bad request"); }

  const { ticket_option, quantity, first_name, last_name, email, phone } = body || {};
  const qty = parseInt(quantity, 10);

  if (!ticket_option) return bad("Missing ticket option.");
  if (!qty || qty < 1) return bad("Choose a quantity.");
  if (qty > MAX_QTY) return bad(`Maximum ${MAX_QTY} tickets per request.`);
  if (!first_name?.trim() || !last_name?.trim()) return bad("Please enter your first and last name.");
  if (!email?.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad("Please enter a valid email.");
  if (!phone?.trim()) return bad("Please enter a contact phone number.");

  const ip = req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "unknown";
  const store = getStore("tc-cache");
  try {
    const key = "rl-" + ip.replace(/[^a-z0-9]/gi, "");
    const last = await store.get(key, { type: "json" });
    if (last && Date.now() - last.t < 60000) return bad("Please wait a moment before trying again.", 429);
    await store.setJSON(key, { t: Date.now() });
  } catch (_) {}

  try {
    const token = await getToken();

    // HOLD ONLY — no confirm step, so no order and no invoice is created.
    const resRes = await fetch(`${BASE}/reservations`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        agent_reference: `WEB-${Date.now()}`,
        products: [{ ticket_option, quantity: qty }],
      }),
    });
    const resJson = await resRes.json();
    if (!resRes.ok || !resJson?.data?.reservation_num) {
      return bad("Sorry — those seats are no longer available. Please try another category.", 409);
    }

    const d = resJson.data;
    const expiresAt = d.expires_at ? d.expires_at * 1000 : null;

    // Record the enquiry for the agent to action.
    try {
      await store.setJSON("hold-" + d.reservation_num, {
        at: Date.now(),
        reservation_num: d.reservation_num,
        expires_at: expiresAt,
        total: d.price_total,
        currency: d.currency,
        customer: { first_name, last_name, email, phone },
        ticket_option, quantity: qty,
        status: "held-awaiting-payment",
      });
    } catch (_) {}

    // Notify the agent — time-critical, the hold expires shortly.
    const cur = d.currency || "GBP";
    const sym = { GBP: "\u00a3", EUR: "\u20ac", USD: "$", ZAR: "R", AUD: "A$" }[cur] || (cur + " ");
    const expStr = expiresAt
      ? new Date(expiresAt).toISOString().replace("T", " ").slice(0, 16) + " UTC"
      : "shortly";

    // --- Telegram (primary alert: instant push to your phone) ---
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      const text =
        `\u26a0\ufe0f SEATS HELD \u2014 ACTION NEEDED\n\n` +
        `Ref: ${d.reservation_num}\n` +
        `Expires: ${expStr}\n` +
        `Value: ${sym}${d.price_total} ${cur}\n` +
        `Tickets: ${qty} \u00d7 option ${ticket_option}\n\n` +
        `${first_name} ${last_name}\n` +
        `\u{1F4DE} ${phone}\n` +
        `\u2709\ufe0f ${email}\n\n` +
        `No order or invoice created \u2014 hold only. Confirm in the Agent Booking Hub to secure.`;
      try {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }),
        });
      } catch (_) {}
    }

    // --- Email (optional backup, only if Resend is configured) ---
    if (process.env.RESEND_API_KEY) {
      const html =
        `<h2>ACTION NEEDED \u2014 seats held ${d.reservation_num}</h2>` +
        `<p><strong>This hold expires ${expStr}.</strong></p>` +
        `<p><strong>Value:</strong> ${sym}${d.price_total} ${cur}<br>` +
        `<strong>Tickets:</strong> ${qty} \u00d7 option ${ticket_option}</p>` +
        `<p><strong>Customer:</strong> ${first_name} ${last_name}<br>Email: ${email}<br>Phone: ${phone}</p>` +
        `<p>No order or invoice has been created \u2014 this is a hold only.</p>`;
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({
            from: process.env.RESEND_FROM || "onboarding@resend.dev",
            to: process.env.ORDER_EMAIL || "orders@grovecorp.org",
            reply_to: email,
            subject: `ACTION: seats held ${d.reservation_num} \u2014 ${first_name} ${last_name}`,
            html,
          }),
        });
      } catch (_) {}
    }

    return new Response(JSON.stringify({
      ok: true,
      reservation_num: d.reservation_num,
      total: d.price_total,
      currency: d.currency,
      expires_at: expiresAt,
    }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    return bad("Something went wrong. Please try again or contact us.", 502);
  }
};
