export async function onRequestGet({ request, env }) {
  try {
    const url  = new URL(request.url);
    const name = (url.searchParams.get('name') || '').trim();
    if (!name) return json({ error: 'Missing name' }, 400);

    const auth    = "Basic " + btoa(`${env.NEXUDUS_API_USERNAME}:${env.NEXUDUS_API_PASSWORD}`);
    const headers = { Authorization: auth, Accept: 'application/json' };

    // time window for visitors (ExpectedArrival today)
    const now   = new Date();
    const start = new Date(now); start.setUTCHours(0,0,0,0);
    const end   = new Date(now); end.setUTCHours(23,59,59,999);
    const isoMinute = (d) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    };

    const needle = name.toLowerCase();

    // ---- visitors today (filter server-side if possible, then local contains) ----
    const vParams = new URLSearchParams({
      page: '1',
      size: '100',
      Visitor_FullName: name,
      from_Visitor_ExpectedArrival: isoMinute(start),
      to_Visitor_ExpectedArrival: isoMinute(end),
      orderBy: 'ExpectedArrival',
      dir: 'Ascending'
    });

    let vRes = await fetch(`https://spaces.nexudus.com/api/spaces/visitors?${vParams.toString()}`, { headers });
    let vRecords = [];
    if (vRes.ok) {
      const vData = await vRes.json();
      vRecords = Array.isArray(vData?.Records) ? vData.Records : [];
    }
    // light local contains filter
    vRecords = vRecords.filter(v => String(v.FullName||'').toLowerCase().includes(needle));

    // ---- coworkers (name search) ----
    const cParams = new URLSearchParams({
      page: '1',
      size: '100',
      Coworker_FullName: name,
      orderBy: 'FullName',
      dir: 'Ascending'
    });

    let cRes = await fetch(`https://spaces.nexudus.com/api/spaces/coworkers?${cParams.toString()}`, { headers });
    let cRecords = [];
    if (cRes.ok) {
      const cData = await cRes.json();
      cRecords = Array.isArray(cData?.Records) ? cData.Records : [];
    }
    cRecords = cRecords.filter(cw => String(cw.FullName||'').toLowerCase().includes(needle));

    // ---- format combined results ----
    const visitorResults = vRecords.map(v => ({
      type: 'visitor',
      id: v.Id,
      label: v.FullName || `Visitor ${v.Id}`,
      sub: `Expected ${v.ExpectedArrival ?? 'n/a'}${v.CoworkerFullName ? ' • Host ' + v.CoworkerFullName : ''}`
    }));

    const coworkerResults = cRecords.map(cw => ({
      type: 'coworker',
      id: cw.Id,
      label: cw.FullName || cw.BillingName || `Coworker ${cw.Id}`,
      sub: cw.Email || ''
    }));

    // Prefer visitors first (since you’re often looking for today)
    const results = [...visitorResults, ...coworkerResults].slice(0, 50);

    return json({ results });
  } catch (e) {
    return json({ error: 'Server error', detail: String(e).slice(0,200) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

