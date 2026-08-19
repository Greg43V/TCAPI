// TEMP: raw look at a competition's products + their date fields, to debug filtering.
// /.netlify/functions/comp-debug?competition=409  — DELETE after use.
const BASE = process.env.TC_BASE || "https://api-sandbox.travelconnectionleisure.com/v1";
async function token(){ const r=await fetch(`${BASE}/oauthorize/token`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({grant_type:"password",username:process.env.TC_USERNAME,password:process.env.TC_PASSWORD})}); if(!r.ok)throw new Error("auth "+r.status); return (await r.json()).access_token; }
export default async (req)=>{
  const c=new URL(req.url).searchParams.get("competition")||"409";
  const out=[]; const L=x=>out.push(x);
  try{
    const t=await token();
    const r=await fetch(`${BASE}/product?competition=${c}&page[number]=1`,{headers:{authorization:`Bearer ${t}`,accept:"application/json"}});
    L("GET /product?competition="+c+" -> "+r.status);
    const d=await r.json();
    L("meta: "+JSON.stringify(d.meta||{}));
    L("count on page 1: "+((d.data||[]).length));
    (d.data||[]).slice(0,6).forEach(p=>{
      L("  id="+p.id+" | "+p.name+" | match="+JSON.stringify(p.match));
    });
  }catch(e){ L("ERR "+String(e&&e.message||e)); }
  return new Response(out.join("\n"),{headers:{"content-type":"text/plain"}});
};
