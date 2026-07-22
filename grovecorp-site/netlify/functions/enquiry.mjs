// netlify/functions/enquiry.mjs
// Receives the homepage enquiry form and pushes it to Telegram (+ records it).
// No email dependency. Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (+ optional RESEND_* backup).

import { getStore } from "@netlify/blobs";

function bad(msg, code = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: code, headers: { "content-type": "application/json" },
  });
}

export default async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);

  let b;
  try { b = await req.json(); } catch { return bad("Bad request"); }

  const name = (b.name || "").trim();
  const email = (b.email || "").trim();
  const interest = (b.interest || "").trim();
  const message = (b.message || "").trim();

  if (!name || !email) return bad("Please add your name and email.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad("Please enter a valid email.");

  // light per-IP rate limit
  const ip = req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "unknown";
  const store = getStore("tc-cache");
  try {
    const key = "enq-rl-" + ip.replace(/[^a-z0-9]/gi, "");
    const last = await store.get(key, { type: "json" });
    if (last && Date.now() - last.t < 30000) return bad("Please wait a moment before sending again.", 429);
    await store.setJSON(key, { t: Date.now() });
  } catch (_) {}

  // record it (so nothing is lost even if notify fails)
  try {
    await store.setJSON("enquiry-" + Date.now(), { at: Date.now(), name, email, interest, message });
  } catch (_) {}

  // Telegram push (primary)
  let notified = false;
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const text =
      `\u{1F4E9} NEW WEBSITE ENQUIRY\n\n` +
      `${name}\n\u2709\ufe0f ${email}\n\n` +
      `Interested in: ${interest || "(not specified)"}\n\n` +
      `${message || "(no message)"}`;
    try {
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }),
      });
      notified = r.ok;
    } catch (_) {}
  }

  // Resend backup (only if configured & verified)
  if (process.env.RESEND_API_KEY) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || "onboarding@resend.dev",
          to: process.env.ORDER_EMAIL || "orders@grovecorp.org",
          reply_to: email,
          subject: `Website enquiry — ${name}`,
          html: `<h2>New enquiry</h2><p><strong>${name}</strong><br>${email}</p>` +
                `<p>Interested in: ${interest}</p><p>${(message || "").replace(/</g, "&lt;")}</p>`,
        }),
      });
    } catch (_) {}
  }

  return new Response(JSON.stringify({ ok: true, notified }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};
