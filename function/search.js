export async function onRequestGet({ request, env }) {
  try {
    const url   = new URL(request.url);
    const type  = (url.searchParams.get('type') || '').toLowerCase();
    const name  = (url.searchParams.get('name') || '').trim();

    if (!['visitor','coworker'].includes(type) || !name) {
      return json({ error: 'Missing or invalid type/name' }, 400);
    }

    const auth = "Basic " + btoa(`${env.NEXUDUS_API_USERNAME}:${env.NEXUDUS_API_PASSWORD}`);

    if (type === 'visitor') {
      // today 00:00 → 23:59:59 UTC
      const now = new Date();
      const start = new Date(now); start.setUTCHours(0,0,0,0);
      const end   = new Date(now); end.setUTCHours(23,59,59,999);
      const iso = d => d.toISOString().split('.')[0] + 'Z';

      const q = new URLSearchParams({
        size: '50',
        Visitor_FullName: name,
        from_Visitor_ExpectedArrival: iso(start),
        to_Visitor_ExpectedArrival: iso(end),
        orderBy: 'ExpectedArrival',
        dir: 'Ascending',
      });

      const api = `https://spaces.nexudus.com/api/spaces/visitors?${q.toString()}`;
      const r = await fetch(api, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (!r.ok) return json({ error: 'Visitor search failed', status: r.status }, 502);

      const data = await r.json();
      const results = (data?.Records || []).map(v => ({
        id: v.Id,
        label: `${v.FullName} ${v.VisitorCode ? `(#${v.VisitorCode})` : ''}`,
        sub: `${v.CoworkerFullName || 'No host'} • Expected ${v.ExpectedArrival ?? 'n/a'}`
      }));

      return json({ results });
    }

    // coworker
    {
      const q = new URLSearchParams({
        size: '50',
        Coworker_FullName: name, // Nexudus supports this filter
        orderBy: 'FullName',
        dir: 'Ascending',
      });
      const api = `https://spaces.nexudus.com/api/spaces/coworkers?${q.toString()}`;
      const r = await fetch(api, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (!r.ok) return json({ error: 'Coworker search failed', status: r.status }, 502);

      const data = await r.json();
      const results = (data?.Records || []).map(cw => ({
        id: cw.Id,
        label: cw.FullName || cw.BillingName || `Coworker ${cw.Id}`,
        sub: cw.Email || ''
      }));

      return json({ results });
    }
  } catch (e) {
    return json({ error: 'Server error', detail: String(e).slice(0,200) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
