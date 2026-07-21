// netlify/functions/tc-reserve.mjs
// Customer-facing booking. Places a hold then immediately confirms it into an order.
// AUTO-CONFIRM: each successful call creates a real TC order + invoice payable by the agent.
// Guardrails: requires customer contact details; quantity capped; light per-IP rate limit.
//
// Env vars: TC_USERNAME, TC_PASSWORD, TC_BASE  (+ optional TC_MAX_QTY, default 6)
//
// The browser NEVER sees TC credentials — this runs server-side.

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

  // --- validation / guardrails ---
  if (!ticket_option) return bad("Missing ticket option.");
  if (!qty || qty < 1) return bad("Choose a quantity.");
  if (qty > MAX_QTY) return bad(`Maximum ${MAX_QTY} tickets per booking.`);
  if (!first_name?.trim() || !last_name?.trim()) return bad("Please enter your first and last name.");
  if (!email?.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad("Please enter a valid email.");
  if (!phone?.trim()) return bad("Please enter a contact phone number.");

  // --- light per-IP rate limit: 1 booking per 60s ---
  const ip = req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "unknown";
  const store = getStore("tc-cache");
  try {
    const key = "rl-" + ip.replace(/[^a-z0-9]/gi, "");
    const last = await store.get(key, { type: "json" });
    if (last && Date.now() - last.t < 60000) return bad("Please wait a moment before booking again.", 429);
    await store.setJSON(key, { t: Date.now() });
  } catch (_) {}

  try {
    const token = await getToken();

    // 1) HOLD
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
      // Most common real cause: category just sold out between page load and click.
      return bad("Sorry — those seats are no longer available. Please try another category.", 409);
    }
    const reservationNum = resJson.data.reservation_num;
    const priceTotal = resJson.data.price_total;
    const currency = resJson.data.currency || "GBP";

    // 2) CONFIRM -> creates the order. Guests: lead booker on all seats.
    const guests = Array.from({ length: qty }, (_, i) => ({
      first_name: i === 0 ? first_name.trim() : first_name.trim(),
      last_name: i === 0 ? last_name.trim() : last_name.trim(),
      ticket_option_id: ticket_option,
      lead: i === 0,
    }));
    const confRes = await fetch(`${BASE}/reservations/${reservationNum}/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ guests }),
    });
    const confJson = await confRes.json();
    if (!confRes.ok || !confJson?.order?.order_no) {
      return bad("We held your seats but couldn't finalise the booking. Please contact us and quote " + reservationNum + ".", 502);
    }

    const order = confJson.order;

    // 3) record for the agent's notification/audit
    try {
      await store.setJSON("order-" + order.order_no, {
        at: Date.now(), order_no: order.order_no, total: order.total, currency: order.currency,
        customer: { first_name, last_name, email, phone },
        ticket_option, quantity: qty, reservation_num: reservationNum,
      });
    } catch (_) {}

    // 4) email notification to the agent (Resend). Best-effort — never fails the booking.
    if (process.env.RESEND_API_KEY) {
      const cur = order.currency || currency;
      const sym = { GBP: "£", EUR: "€", USD: "$", ZAR: "R" }[cur] || (cur + " ");
      const html =
        `<h2>New website booking — ${order.order_no}</h2>` +
        `<p><strong>Total:</strong> ${sym}${order.total} ${cur}</p>` +
        `<p><strong>Tickets:</strong> ${qty} × option ${ticket_option}</p>` +
        `<p><strong>Customer:</strong> ${first_name} ${last_name}<br>` +
        `Email: ${email}<br>Phone: ${phone}</p>` +
        `<p><strong>Reservation:</strong> ${reservationNum}</p>` +
        `<p>Invoice this order and arrange payment. View it in the Agent Booking Hub.</p>`;
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({
            from: process.env.RESEND_FROM || "bookings@grovecorp.org",
            to: process.env.ORDER_EMAIL || "orders@grovecorp.org",
            reply_to: email,
            subject: `New booking ${order.order_no} — ${first_name} ${last_name}`,
            html,
          }),
        });
      } catch (_) {}
    }

    return new Response(JSON.stringify({
      ok: true,
      order_no: order.order_no,
      total: order.total,
      currency: order.currency,
    }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    return bad("Something went wrong placing the booking. Please try again or contact us.", 502);
  }
};
