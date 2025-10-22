export async function onRequestGet({ request, env }) {
  try {
    const url  = new URL(request.url);
    const name = (url.searchParams.get('name') || '').trim();
    if (!name) return json({ error: 'Missing name' }, 400);

    const auth = "Basic " + btoa(`${env.NEXUDUS_API_USERNAME}:${env.NEXUDUS_API_PASSWORD}`);
    const headers = { Authorization: auth, Accept: 'application/json' };

    // UTC today window
    const now = new Date();
    const start = new Date(now); start.setUTCHours(0,0,0,0);
    const end   = new Date(now); end.setUTCHours(23,59,59,999);
    const iso = d => d.toISOString().split('.')[0] + 'Z';
    const contains = (hay, needle) => String(hay || '').toLowerCase().includes(String(needle).toLowerCase());

    // --- 1) Today's coworker bookings (to allow instant pass) ---
    const bParams = new URLSearchParams({
      page: '1',
      size: '500',
      from_Booking_FromTime: iso(start),
      to_Booking_ToTime: iso(end),
      status: 'Confirmed'
    });
    const bRes = await fetch(`https://spaces.nexudus.com/api/spaces/bookings?${bParams}`, { headers });
    const bData = bRes.ok ? await bRes.json() : { Records: [] };
    const bookingMatches = (bData.Records || [])
      .filter(b => contains(b.CoworkerFullName, name))
      .map(b => ({
        type: 'coworker',
        id: String(b.Booking_Coworker?.Id || b.Booking_Coworker || b.CoworkerId || ''), // best-effort
        label: b.CoworkerFullName || 'Unknown coworker',
        sub: `${b.ResourceName || 'Resource'} • ${b.FromTime || ''} → ${b.ToTime || ''}`
      }))
      // drop any result that couldn't resolve an id
      .filter(r => /^\d+$/.test(r.id));

    // --- 2) Today's visitors (ExpectedArrival today) ---
    // Try server-side filter; fall back to local filter if not supported.
    let visitorRecords = [];
    const vParams = new URLSearchParams({
      page: '1',
      size: '200',
      from_Visitor_ExpectedArrival: iso(start),
      to_Visitor_ExpectedArrival: iso(end)
    });
    const vUrl = `https://spaces.nexudus.com/api/spaces/visitors?${vParams}`;
    const vRes = await fetch(vUrl, { headers });
    if (vRes.ok) {
      const vData = await vRes.json();
      visitorRecords = Array.isArray(vData.Records) ? vData.Records : [];
    }
    const visitorMatches = visitorRecords
      .filter(v => contains(v.FullName, name))
      .map(v => ({
        type: 'visitor',
        id: String(v.Id),
        label: v.FullName,
        sub: `${v.CoworkerFullName || 'No host'} • Expected ${v.ExpectedArrival || 'n/a'}`
      }));

    // Merge, prefer upcoming first
    const results = [...bookingMatches, ...visitorMatches];
    return json({ results });
  } catch (e) {
    return json({ error: 'Server error', detail: String(e).slice(0, 200) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
