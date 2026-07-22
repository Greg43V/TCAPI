// TEMP diagnostic: shows exactly what the LIVE product-detail call returns.
// Open /.netlify/functions/tc-detail-debug?id=<live product id>. Delete after use.
export default async (req) => {
  const BASE = process.env.TC_BASE || "https://api-sandbox.travelconnectionleisure.com/v1";
  const id = new URL(req.url).searchParams.get("id");
  const out = [];
  const line = (s) => out.push(s);
  line("BASE: " + BASE);
  line("id: " + id);
  if (!id) return new Response("add ?id=<product id>", { status: 400 });
  try {
    const tr = await fetch(`${BASE}/oauthorize/token`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ grant_type: "password", username: process.env.TC_USERNAME, password: process.env.TC_PASSWORD }),
    });
    line("auth status: " + tr.status);
    const tj = await tr.json();
    const token = tj.access_token;
    line("token: " + (token ? "yes" : "NO -> " + JSON.stringify(tj)));
    if (!token) return new Response(out.join("\n"), { headers: { "content-type": "text/plain" } });

    const pr = await fetch(`${BASE}/product/${id}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    line("product/" + id + " status: " + pr.status);
    const pj = await pr.json();
    const d = pj.data || {};
    line("");
    line("name: " + d.name);
    line("venue id: " + JSON.stringify(d.venue));
    line("information: " + JSON.stringify(d.information));
    line("notes: " + JSON.stringify(d.notes));
    line("timetable: " + JSON.stringify(d.timetable));
    line("seating_plan: " + JSON.stringify(d.seating_plan));
    line("images: " + JSON.stringify(d.images));

    if (d.venue) {
      const vr = await fetch(`${BASE}/venues/${d.venue}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      line("");
      line("venues/" + d.venue + " status: " + vr.status);
      const vj = await vr.json();
      const v = vj.data || {};
      line("venue name: " + v.name);
      line("coordinates: " + JSON.stringify(v.coordinates));
      line("venue images: " + JSON.stringify(v.images));
    }
  } catch (e) {
    line("ERROR: " + String(e && e.message || e));
  }
  return new Response(out.join("\n"), { headers: { "content-type": "text/plain" } });
};
