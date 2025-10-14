export async function onRequestGet({ request, env }) {
  try {
    const url  = new URL(request.url);
    const type = (url.searchParams.get('type') || '').toLowerCase();
    const id   = url.searchParams.get('id');

    if (!['visitor','coworker'].includes(type) || !id) {
      return json({ error: 'Missing or invalid type/id' }, 400);
    }

    const auth = "Basic " + btoa(`${env.NEXUDUS_API_USERNAME}:${env.NEXUDUS_API_PASSWORD}`);

    // ---------- VISITOR PASS ----------
    if (type === 'visitor') {
      // The {id} path form expects a GUID; a numeric Id will throw
      // “The string did not match the expected pattern.”
      // Use a filtered list query instead.
      const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
      const isNumeric = /^\d+$/.test(id);

      // Prefer UniqueId (GUID) when provided; otherwise filter by numeric Id
      const q = new URLSearchParams({
        size: '1',
        page: '1',
        ...(isGuid ? { UniqueId: id } : isNumeric ? { Id: id } : { }) // fallback leaves no filter if id is neither
      });

      const api = `https://spaces.nexudus.com/api/spaces/visitors?${q.toString()}`;
      const r = await fetch(api, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (!r.ok) return json({ error: 'Visitor fetch failed', status: r.status }, 502);

      const data = await r.json();
      const records = Array.isArray(data?.Records) ? data.Records : [];
      const v = records[0] || null;

      if (!v) return json({ error: 'Visitor not found' }, 404);
      return json({ visitor: v });
    }

    // ---------- COWORKER (BOOKINGS FOR TODAY) ----------
    const now = new Date();
    const start = new Date(now); start.setUTCHours(0,0,0,0);
    const end   = new Date(now); end.setUTCHours(23,59,59,999);
    const iso = d => d.toISOString().split('.')[0] + 'Z';

    const q = new URLSearchParams({
      Booking_Coworker: id,
      from_Booking_FromTime: iso(start),
      to_Booking_ToTime: iso(end),
      status: 'Confirmed',
      size: '500',
      page: '1'
    });

    const api = `https://spaces.nexudus.com/api/spaces/bookings?${q.toString()}`;
    const r = await fetch(api, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!r.ok) return json({ error: 'Bookings fetch failed', status: r.status }, 502);

    const data = await r.json();
    return json({ bookings: Array.isArray(data?.Records) ? data.Records : [] });

  } catch (e) {
    return json({ error: 'Server error', detail: String(e).slice(0,200) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
