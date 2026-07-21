import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";

export default async (req) => {
  const raw = await req.text();

  const secret = process.env.TC_WEBHOOK_SECRET;
  const sig = req.headers.get("x-signature") || "";
  if (secret) {
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) return new Response(null, { status: 204 });
  }

  let payload;
  try { payload = JSON.parse(raw); } catch { return new Response(null, { status: 204 }); }

  const type = payload?.event?.type;
  const data = payload?.event?.data;

  try {
    if (type === "football_match.kickoff.updated" && data?.product) {
      const p = data.product;
      const store = getStore("tc-cache");
      const productsMeta = await store.get("products", { type: "json" });
      if (productsMeta?.list) {
        const idx = productsMeta.list.findIndex((f) => f.id === p.id);
        if (idx !== -1 && p.match?.start) {
          productsMeta.list[idx].date = p.match.start.local;
          productsMeta.list[idx].utc = p.match.start.utc;
          await store.setJSON("products", productsMeta);
        }
      }
      await store.setJSON("last-webhook", { at: Date.now(), type, product: p.id });
    }
  } catch (_) {}

  return new Response(null, { status: 200 });
};
