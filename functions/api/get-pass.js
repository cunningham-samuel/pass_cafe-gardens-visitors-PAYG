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

    // ---- time helpers (UTC "minute" precision, as Nexudus expects) ----
    const now   = new Date();
    const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
    const end   = new Date(now); end.setUTCHours(23, 59, 59, 999);

    const isoMinute = (d) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    };

    const isActive = (from, to, padMin = 15) => {
      const s = new Date(from), e = new Date(to);
      return now >= new Date(s.getTime() - padMin*60000) && now <= new Date(e.getTime() + padMin*60000);
    };

    // ---- fetch today's bookings once (used by both flows) ----
    const bookingsUrl = `https://spaces.nexudus.com/api/spaces/bookings?` +
      new URLSearchParams({
        page: '1',
        size: '500',
        status: 'Confirmed',
        from_Booking_FromTime: isoMinute(start),
        to_Booking_ToTime: isoMinute(end),
      });

    const bRes = await fetch(bookingsUrl, { headers });
    const allBookings = bRes.ok ? (await bRes.json())?.Records || [] : [];

    // ---------- COWORKER FLOW ----------
    if (type === 'coworker') {
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

    // ---------- VISITOR FLOW ----------
    // 1) get the visitor record (mostly to confirm the name / id)
    const vRes = await fetch(`https://spaces.nexudus.com/api/spaces/visitors/${encodeURIComponent(id)}`, { headers });
    if (!vRes.ok) return json({ error: 'Visitor fetch failed', status: vRes.status }, 502);
    const v = await vRes.json();
    const visitorName = String(v.FullName || '').trim().toLowerCase();

    // 2) page through /bookingvisitors and collect any rows that refer to this visitor
    const bookingIdSet = new Set();

    // helper to fetch paginated endpoints
    async function fetchPage(baseUrl, page, size = 200) {
      const u = `${baseUrl}?${new URLSearchParams({ page: String(page), size: String(size) })}`;
      const r = await fetch(u, { headers });
      if (!r.ok) return null;
      return r.json();
    }

    const baseBV = `https://spaces.nexudus.com/api/spaces/bookingvisitors`;
    // cap at 10 pages defensively
    for (let page = 1; page <= 10; page++) {
      const data = await fetchPage(baseBV, page, 200);
      if (!data) break;
      const rows = Array.isArray(data.Records) ? data.Records : [];

      for (const row of rows) {
        const sameId   = String(row.VisitorId || '') === String(id);
        const sameName = String(row.VisitorFullName || '').trim().toLowerCase() === visitorName;
        if (sameId || sameName) {
          if (row.BookingId) bookingIdSet.add(row.BookingId);
        }
      }
      if (!data.HasNextPage) break;
    }

    // 3) cross-match to today’s bookings
    const candidates = allBookings.filter(b => bookingIdSet.has(b.Id));
    const active     = candidates.find(b => isActive(b.FromTime, b.ToTime));
    const chosen     = active || candidates.sort((a,b)=> new Date(b.ToTime) - new Date(a.ToTime))[0];

    if (chosen) {
      return json({
        source: 'booking',
        pass: {
          name: v.FullName || 'Visitor',
          resource: chosen.ResourceName || 'N/A',
          fromTime: chosen.FromTime || null,
          toTime: chosen.ToTime || null
        }
      });
    }

    // 4) fallback — no linked booking found; show minimal visitor info
    return json({
      source: 'visitor-fallback',
      pass: {
        name: v.FullName || 'Visitor',
        resource:
          v?.CustomFields?.Data?.find(d => d.Name === 'Nexudus.Booking.ResourceName')?.Value || 'N/A',
        fromTime:
          v?.CustomFields?.Data?.find(d => d.Name === 'Nexudus.Booking.FromTime')?.Value ||
          v.ExpectedArrival || null,
        toTime: null
      }
    });
  } catch (e) {
    return json({ error: 'Server error', detail: String(e).slice(0, 400) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
