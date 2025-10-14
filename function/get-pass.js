export async function onRequestGet({ request, env }) {
  try {
    const url  = new URL(request.url);
    const type = (url.searchParams.get('type') || '').toLowerCase();
    const id   = url.searchParams.get('id');

    if (!['visitor','coworker'].includes(type) || !id) {
      return json({ error: 'Missing or invalid type/id' }, 400);
    }

    const auth = "Basic " + btoa(`${env.NEXUDUS_API_USERNAME}:${env.NEXUDUS_API_PASSWORD}`);

    if (type === 'visitor') {
      // Fetch single visitor by id
      // Nexudus entity endpoints allow /spaces/visitors/{id}
      const api = `https://spaces.nexudus.com/api/spaces/visitors/${encodeURIComponent(id)}`;
      const r = await fetch(api, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (!r.ok) return json({ error: 'Visitor fetch failed', status: r.status }, 502);
      const v = await r.json();
      return json({ visitor: v });
    }

    // coworker bookings for today
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
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
