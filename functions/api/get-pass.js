export async function onRequestGet({ request, env }) {
  try {
    const url  = new URL(request.url);
    const type = (url.searchParams.get('type') || '').toLowerCase(); // 'visitor' | 'coworker'
    const id   = url.searchParams.get('id');

    if (!['visitor','coworker'].includes(type) || !id) {
      return json({ error: 'Missing or invalid type/id' }, 400);
    }
    if (!/^\d+$/.test(id)) {
      return json({ error: 'id must be numeric' }, 400);
    }

    const auth    = "Basic " + btoa(`${env.NEXUDUS_API_USERNAME}:${env.NEXUDUS_API_PASSWORD}`);
    const headers = { Authorization: auth, Accept: 'application/json' };

    // ---- time helpers (UTC with minutes/seconds as needed) ----
    const now   = new Date();
    const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
    const end   = new Date(now); end.setUTCHours(23, 59, 59, 999);

    const isActive = (from, to, padMin = 15) => {
      const s = new Date(from), e = new Date(to);
      return now >= new Date(s.getTime() - padMin*60000) && now <= new Date(e.getTime() + padMin*60000);
    };
    const overlapsToday = (from, to) => {
      const s = new Date(from), e = new Date(to);
      return e >= start && s <= end;
    };

    // ---------- COWORKER FLOW (unchanged) ----------
    if (type === 'coworker') {
      // get today's confirmed bookings (list) and filter by coworker id
      const listUrl = `https://spaces.nexudus.com/api/spaces/bookings?` + new URLSearchParams({
        page: '1',
        size: '500',
        status: 'Confirmed',
        from_Booking_FromTime: utcYYYYMMDD_HHMM(start),
        to_Booking_ToTime:     utcYYYYMMDD_HHMM(end),
      });
      const bRes = await fetch(listUrl, { headers });
      const allBookings = bRes.ok ? (await bRes.json())?.Records || [] : [];

      const mine = allBookings.filter(b =>
        String(b.Booking_Coworker?.Id || b.CoworkerId || b.Coworker?.Id || '') === String(id)
      );
      const active = mine.find(b => isActive(b.FromTime, b.ToTime));
      const chosen = active || mine.sort((a,b)=> new Date(b.ToTime) - new Date(a.ToTime))[0];

      if (!chosen) return json({ source: 'none', pass: null });

      return json({
        source: 'booking',
        pass: {
          name: chosen.CoworkerFullName || 'N/A',
          resource: chosen.ResourceName || 'N/A',
          fromTime: chosen.FromTime || null,
          toTime: chosen.ToTime || null
        }
      });
    }

    // ---------- VISITOR FLOW (new 1→2→3→4 logic) ----------
    // 1) (Search step is done in search.js; here we already have the Visitor Id.)
    //    Fetch the visitor (for the display name).
    const vRes = await fetch(`https://spaces.nexudus.com/api/spaces/visitors/${encodeURIComponent(id)}`, { headers });
    if (!vRes.ok) return json({ error: 'Visitor fetch failed', status: vRes.status }, 502);
    const visitor = await vRes.json();
    const visitorName = visitor?.FullName || 'Visitor';

    // 2) Find bookingvisitor rows for this visitor using the filter BookingVisitor_Visitor
    const bookingIds = new Set();
    for (let page = 1; page <= 10; page++) { // defensive pagination cap
      const bvUrl = `https://spaces.nexudus.com/api/spaces/bookingvisitors?` + new URLSearchParams({
        page: String(page),
        size: '200',
        BookingVisitor_Visitor: String(id)       // <-- required filter
      });
      const r = await fetch(bvUrl, { headers });
      if (!r.ok) break;
      const data = await r.json();
      const rows = Array.isArray(data?.Records) ? data.Records : [];
      rows.forEach(row => { if (row.BookingId) bookingIds.add(row.BookingId); });
      if (!data?.HasNextPage) break;
    }

    if (bookingIds.size === 0) {
      // No linked bookings
      return json({ source: 'visitor-no-linked-booking', pass: null });
    }

    // 3) For each BookingId, fetch the booking by id endpoint and keep those that overlap today
    const candidates = [];
    for (const bid of bookingIds) {
      const br = await fetch(`https://spaces.nexudus.com/api/spaces/bookings/${encodeURIComponent(bid)}`, { headers });
      if (!br.ok) continue;
      const bk = await br.json();
      if (!bk?.FromTime || !bk?.ToTime) continue;
      if (overlapsToday(bk.FromTime, bk.ToTime)) candidates.push(bk);
    }

    if (candidates.length === 0) {
      return json({ source: 'visitor-no-todays-booking', pass: null });
    }

    // prefer active first, else latest ending today
    const active = candidates.find(b => isActive(b.FromTime, b.ToTime));
    const chosen = active || candidates.sort((a,b)=> new Date(b.ToTime) - new Date(a.ToTime))[0];

    return json({
      source: 'booking',
      pass: {
        name: visitorName,
        resource: chosen.ResourceName || 'N/A',
        fromTime: chosen.FromTime || null,
        toTime: chosen.ToTime || null
      }
    });

  } catch (e) {
    return json({ error: 'Server error', detail: String(e).slice(0, 400) }, 500);
  }
}

// ---- helpers ----
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// Nexudus list filters want UTC without seconds for bookings list (what you already used);
// we keep that here for coworker flow:
function utcYYYYMMDD_HHMM(d){
  const p = (n)=> String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

