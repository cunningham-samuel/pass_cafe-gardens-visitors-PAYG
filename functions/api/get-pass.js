export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const type = (url.searchParams.get('type') || '').toLowerCase(); // 'visitor' | 'coworker'
    const id   = url.searchParams.get('id');

    if (!['visitor','coworker'].includes(type) || !id) {
      return json({ error: 'Missing or invalid type/id' }, 400);
    }

    const auth = "Basic " + btoa(`${env.NEXUDUS_API_USERNAME}:${env.NEXUDUS_API_PASSWORD}`);
    const headers = { Authorization: auth, Accept: 'application/json' };

    // UTC today
    const now = new Date();
    const start = new Date(now); start.setUTCHours(0,0,0,0);
    const end   = new Date(now); end.setUTCHours(23,59,59,999);
    const iso = d => d.toISOString().split('.')[0] + 'Z';
    const isActive = (from, to, padMin = 15) => {
      const s = new Date(from), e = new Date(to);
      return now >= new Date(s.getTime() - padMin*60000) && now <= new Date(e.getTime() + padMin*60000);
    };

    // Fetch all today's bookings once (used by both flows)
    const bookingsUrl = `https://spaces.nexudus.com/api/spaces/bookings?` +
      new URLSearchParams({
        page: '1', size: '500', status: 'Confirmed',
        from_Booking_FromTime: iso(start),
        to_Booking_ToTime: iso(end)
      });
    const bRes = await fetch(bookingsUrl, { headers });
    const allBookings = bRes.ok ? (await bRes.json())?.Records || [] : [];

    // ---- Coworker flow (id = coworkerId) ----
    if (type === 'coworker') {
      if (!/^\d+$/.test(id)) return json({ error: 'coworker id must be numeric' }, 400);
      const mine = allBookings.filter(b =>
        String(b.Booking_Coworker?.Id || b.Booking_Coworker || b.CoworkerId || '') === String(id)
      );

      // choose active if any, otherwise the latest ending booking today
      const active = mine.find(b => isActive(b.FromTime, b.ToTime));
      const chosen = active || mine.sort((a,b)=>new Date(b.ToTime)-new Date(a.ToTime))[0];
      if (!chosen) return json({ pass: null });

      return json({
        pass: {
          name: chosen.CoworkerFullName || 'N/A',
          resource: chosen.ResourceName || 'N/A',
          fromTime: chosen.FromTime || null,
          toTime: chosen.ToTime || null
        }
      });
    }

    // ---- Visitor flow (id = visitorId) ----
    if (!/^\d+$/.test(id)) return json({ error: 'visitor id must be numeric' }, 400);

    // Get the visitor record
    const vRes = await fetch(`https://spaces.nexudus.com/api/spaces/visitors/${encodeURIComponent(id)}`, { headers });
    if (!vRes.ok) return json({ error: 'Visitor fetch failed', status: vRes.status }, 502);
    const v = await vRes.json();

    // Try to associate to a booking via /spaces/bookingvisitors (then match by BookingId)
    let bvRecords = [];
    const bvUrl = `https://spaces.nexudus.com/api/spaces/bookingvisitors?` +
      new URLSearchParams({ page: '1', size: '200' });
    const bvRes = await fetch(bvUrl, { headers });
    if (bvRes.ok) {
      const data = await bvRes.json();
      const all = Array.isArray(data?.Records) ? data.Records : [];
      // best-effort match by VisitorId or VisitorFullName
      const needle = String(v.FullName || '').toLowerCase();
      bvRecords = all.filter(x =>
        String(x.VisitorId || '').trim() === String(v.Id) ||
        String(x.VisitorFullName || '').toLowerCase() === needle
      );
    }

    // Cross-match with today's bookings
    const bookingIdSet = new Set(bvRecords.map(x => x.BookingId).filter(Boolean));
    const candidates = allBookings.filter(b => bookingIdSet.has(b.Id));

    // choose active if any, otherwise the latest ending booking today
    let chosen = candidates.find(b => isActive(b.FromTime, b.ToTime));
    if (!chosen) chosen = candidates.sort((a,b)=>new Date(b.ToTime)-new Date(a.ToTime))[0];

    // As a fallback (no linked booking), try to display something using visitor clues
    if (!chosen) {
      return json({
        pass: {
          name: v.FullName || 'Visitor',
          resource: v?.CustomFields?.Data?.find(d => d.Name === 'Nexudus.Booking.ResourceName')?.Value || 'N/A',
          fromTime: v?.CustomFields?.Data?.find(d => d.Name === 'Nexudus.Booking.FromTime')?.Value || v.ExpectedArrival || null,
          toTime: null
        }
      });
    }

    return json({
      pass: {
        name: v.FullName || 'Visitor',
        resource: chosen.ResourceName || 'N/A',
        fromTime: chosen.FromTime || null,
        toTime: chosen.ToTime || null
      }
    });
  } catch (e) {
    return json({ error: 'Server error', detail: String(e).slice(0, 400) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
