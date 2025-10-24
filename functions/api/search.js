export async function onRequestGet({ request, env }) {
  try {
    const url  = new URL(request.url);
    const name = (url.searchParams.get('name') || '').trim();
    if (!name) return json({ error: 'Missing name' }, 400);

    const auth    = "Basic " + btoa(`${env.NEXUDUS_API_USERNAME}:${env.NEXUDUS_API_PASSWORD}`);
    const headers = { Authorization: auth, Accept: 'application/json' };

    // ---- time window for visitors (ExpectedArrival today, with seconds) ----
    const now   = new Date();
    const start = new Date(now); start.setUTCHours(0,0,0,0);
    const end   = new Date(now); end.setUTCHours(23,59,59,999);

    const isoSec = (d) => {
      const p = (n)=> String(n).padStart(2,'0');
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    };

    // Added: ISO without ms + active-window helper
    const isoNoMs = (d) => d.toISOString().split('.')[0] + 'Z';
    const isActive = (from, to, padMin = 15) => {
      const s = new Date(from), e = new Date(to);
      return now >= new Date(s.getTime() - padMin*60000) && now <= new Date(e.getTime() + padMin*60000);
    };

    const needle = name.toLowerCase();

    // UK formatter -> "YYYY-MM-DD HH:MM" in Europe/London
    const formatUK = (dt) => {
      const d = new Date(dt);
      if (Number.isNaN(d.getTime())) return 'n/a';
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).formatToParts(d);
      const get = (t) => parts.find(p => p.type === t)?.value || '';
      const dd = get('day');
      const mm = get('month');
      const yyyy = get('year');
      const hh = get('hour');
      const min = get('minute');
      return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
    };

    // ---- fetch today's confirmed bookings once (used for both visitors & coworkers) ----
    const bookingsUrl = `https://spaces.nexudus.com/api/spaces/bookings?` +
      new URLSearchParams({
        page: '1',
        size: '500',
        status: 'Confirmed',
        from_Booking_FromTime: isoNoMs(start),
        to_Booking_ToTime: isoNoMs(end)
      });
    const bRes = await fetch(bookingsUrl, { headers });
    const allBookings = bRes.ok ? ((await bRes.json())?.Records || []) : [];
    const bookingById = new Map(allBookings.map(b => [String(b.Id), b]));

    // ---- visitors (today) ----
    const vParams = new URLSearchParams({
      page: '1',
      size: '100',
      Visitor_FullName: name,
      from_Visitor_ExpectedArrival: isoSec(start),  // <-- with seconds
      to_Visitor_ExpectedArrival:   isoSec(end),    // <-- with seconds
      orderBy: 'ExpectedArrival',
      dir: 'Ascending'
    });

    let vRes = await fetch(`https://spaces.nexudus.com/api/spaces/visitors?${vParams.toString()}`, { headers });
    let vRecords = [];
    if (vRes.ok) {
      const vData = await vRes.json();
      vRecords = Array.isArray(vData?.Records) ? vData.Records : [];
    }
    vRecords = vRecords.filter(v => String(v.FullName||'').toLowerCase().includes(needle));

    // For each visitor: look up bookingvisitors & keep only active bookings
    const visitorResults = [];
    for (const v of vRecords) {
      const bvParams = new URLSearchParams({
        page: '1',
        size: '100',
        BookingVisitor_Visitor: String(v.Id)
      });
      const bvUrl = `https://spaces.nexudus.com/api/spaces/bookingvisitors?${bvParams.toString()}`;
      const bvr = await fetch(bvUrl, { headers });
      if (!bvr.ok) continue;

      const bvData = await bvr.json();
      const linked = (Array.isArray(bvData?.Records) ? bvData.Records : [])
        .map(x => bookingById.get(String(x.BookingId)))
        .filter(Boolean);

      const active = linked.filter(b => b.FromTime && b.ToTime && isActive(b.FromTime, b.ToTime));
      if (!active.length) continue;

      const chosen = active.sort((a,b)=> new Date(b.ToTime) - new Date(a.ToTime))[0];

      visitorResults.push({
        type: 'visitor',
        id: v.Id,
        label: v.FullName || `Visitor ${v.Id}`,
        sub: `From ${formatUK(chosen.FromTime)} to ${formatUK(chosen.ToTime)}${chosen.ResourceName ? ' • ' + chosen.ResourceName : ''}`
      });
    }

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

    // Only return coworkers with an active booking now
    const coworkerResults = [];
    for (const cw of cRecords) {
      const myBookings = allBookings.filter(b => {
        const bid = String(b.Booking_Coworker?.Id || b.CoworkerId || '');
        return bid === String(cw.Id);
      });
      const active = myBookings.filter(b => b.FromTime && b.ToTime && isActive(b.FromTime, b.ToTime));
      if (!active.length) continue;

      const chosen = active.sort((a,b)=> new Date(b.ToTime) - new Date(a.ToTime))[0];

      coworkerResults.push({
        type: 'coworker',
        id: cw.Id,
        label: cw.FullName || cw.BillingName || `Coworker ${cw.Id}`,
        sub: `From ${formatUK(chosen.FromTime)} to ${formatUK(chosen.ToTime)}${chosen.ResourceName ? ' • ' + chosen.ResourceName : ''}`
      });
    }

    return json({ results: [...visitorResults, ...coworkerResults].slice(0, 50) });
  } catch (e) {
    return json({ error: 'Server error', detail: String(e).slice(0,200) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}


