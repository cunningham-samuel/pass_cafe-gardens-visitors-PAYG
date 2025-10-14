export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);

    // Inputs (support legacy ?id=... too)
    const typeParam = (url.searchParams.get('type') || '').toLowerCase(); // 'visitor' | 'coworker'
    const legacyId  = url.searchParams.get('id'); // may be numeric id or a name
    const visitorId = url.searchParams.get('visitorId');
    const visitorName = url.searchParams.get('visitorName');
    const coworkerId = url.searchParams.get('coworkerId');
    const coworkerName = url.searchParams.get('coworkerName');

    if (!['visitor', 'coworker'].includes(typeParam)) {
      return json({ error: "Missing or invalid 'type'. Use type=visitor or type=coworker." }, 400);
    }

    // Map legacy 'id' if present
    let vId = visitorId;
    let vName = visitorName;
    let cId = coworkerId;
    let cName = coworkerName;

    if (legacyId) {
      if (/^\d+$/.test(legacyId)) {
        if (typeParam === 'visitor') vId = legacyId;
        if (typeParam === 'coworker') cId = legacyId;
      } else {
        if (typeParam === 'visitor') vName = legacyId;
        if (typeParam === 'coworker') cName = legacyId;
      }
    }

    // Require some identifier
    if (typeParam === 'visitor' && !vId && !vName) {
      return json({ error: "Provide visitorId=<number> or visitorName=<text> (or id=...)" }, 400);
    }
    if (typeParam === 'coworker' && !cId && !cName) {
      return json({ error: "Provide coworkerId=<number> or coworkerName=<text> (or id=...)" }, 400);
    }

    const auth = "Basic " + btoa(`${env.NEXUDUS_API_USERNAME}:${env.NEXUDUS_API_PASSWORD}`);

    // Small cache buster while iterating
    const cacheBust = `t=${Date.now()}`;

    // ---------- Time window (UTC today) ----------
    const now = new Date();
    const start = new Date(now); start.setUTCHours(0,0,0,0);
    const end   = new Date(now); end.setUTCHours(23,59,59,999);
    const iso = d => d.toISOString().split('.')[0] + 'Z';

    // ---------- VISITOR FLOW ----------
    if (typeParam === 'visitor') {
      // If numeric ID → call the by-id endpoint
      if (vId) {
        if (!/^\d+$/.test(vId)) {
          return json({ error: "visitorId must be a number. If you only have a name, use visitorName=..." }, 400);
        }
        const byId = `https://spaces.nexudus.com/api/spaces/visitors/${encodeURIComponent(vId)}?${cacheBust}`;
        const r = await fetch(byId, { headers: baseHeaders(auth) });
        if (!r.ok) return json({ error: 'Visitor fetch failed', status: r.status, details: await safePeek(r) }, 502);
        const v = await r.json();
        return json({ visitor: v });
      }

      // Lookup by name – try server-side filters first (exact name + today’s window)
      const exactParams = new URLSearchParams({
        page: '1',
        size: '100',
        Visitor_FullName: String(vName).trim(),
        from_Visitor_ExpectedArrival: iso(start),
        to_Visitor_ExpectedArrival: iso(end),
      });
      let listUrl = `https://spaces.nexudus.com/api/spaces/visitors?${exactParams.toString()}&${cacheBust}`;
      let lr = await fetch(listUrl, { headers: baseHeaders(auth) });

      let records = [];
      if (lr.ok) {
        const payload = await lr.json();
        records = Array.isArray(payload?.Records) ? payload.Records : [];
      } else {
        // If their filter combo is not accepted on your account, we’ll fall back below.
        // (Don’t bail out on this error yet.)
      }

      // Fallback: broader fetch then client-side contains match
      if (records.length === 0) {
        const broadParams = new URLSearchParams({
          page: '1',
          size: '200',
          // If the above exact filter was rejected, omit it here and we’ll filter locally:
          from_Visitor_ExpectedArrival: iso(start),
          to_Visitor_ExpectedArrival: iso(end),
        });
        listUrl = `https://spaces.nexudus.com/api/spaces/visitors?${broadParams.toString()}&${cacheBust}`;
        lr = await fetch(listUrl, { headers: baseHeaders(auth) });
        if (!lr.ok) {
          return json({ error: 'Visitor list fetch failed', status: lr.status, details: await safePeek(lr) }, 502);
        }
        const payload = await lr.json();
        const all = Array.isArray(payload?.Records) ? payload.Records : [];
        const needle = String(vName).trim().toLowerCase();
        records = all.filter(v => String(v.FullName || '').toLowerCase().includes(needle));
      }

      if (records.length === 0) {
        // Final fallback: no date window at all, page + contains
        const finalParams = new URLSearchParams({ page: '1', size: '200' });
        listUrl = `https://spaces.nexudus.com/api/spaces/visitors?${finalParams.toString()}&${cacheBust}`;
        const fr = await fetch(listUrl, { headers: baseHeaders(auth) });
        if (!fr.ok) {
          return json({ error: 'Visitor list fetch failed', status: fr.status, details: await safePeek(fr) }, 502);
        }
        const payload = await fr.json();
        const all = Array.isArray(payload?.Records) ? payload.Records : [];
        const needle = String(vName).trim().toLowerCase();
        records = all.filter(v => String(v.FullName || '').toLowerCase().includes(needle));
      }

      if (records.length === 0) {
        return json({ error: 'No visitors found by that name', query: vName }, 404);
      }

      // Prefer upcoming first, then most recent past
      const upcoming = records
        .filter(v => v.ExpectedArrival && new Date(v.ExpectedArrival) >= now)
        .sort((a, b) => new Date(a.ExpectedArrival) - new Date(b.ExpectedArrival));
      const past = records
        .filter(v => v.ExpectedArrival && new Date(v.ExpectedArrival) < now)
        .sort((a, b) => new Date(b.ExpectedArrival) - new Date(a.ExpectedArrival));

      const chosen = upcoming[0] || past[0] || records[0];
      return json({ visitor: chosen, matches: records.length });
    }

    // ---------- COWORKER (BOOKINGS) FLOW ----------
    // Resolve coworkerId
    let resolvedCoworkerId = cId;

    if (!resolvedCoworkerId && cName) {
      // Try server-side exact name first
      const exactParams = new URLSearchParams({
        page: '1',
        size: '100',
        Coworker_FullName: String(cName).trim(),
      });
      let cUrl = `https://spaces.nexudus.com/api/spaces/coworkers?${exactParams.toString()}&${cacheBust}`;
      let cRes = await fetch(cUrl, { headers: baseHeaders(auth) });

      let crew = [];
      if (cRes.ok) {
        const cData = await cRes.json();
        crew = Array.isArray(cData?.Records) ? cData.Records : [];
      }

      // Fallback: page + contains match
      if (crew.length === 0) {
        const broadParams = new URLSearchParams({ page: '1', size: '200' });
        cUrl = `https://spaces.nexudus.com/api/spaces/coworkers?${broadParams.toString()}&${cacheBust}`;
        cRes = await fetch(cUrl, { headers: baseHeaders(auth) });
        if (!cRes.ok) {
          return json({ error: 'Coworker list fetch failed', status: cRes.status, details: await safePeek(cRes) }, 502);
        }
        const cData = await cRes.json();
        const all = Array.isArray(cData?.Records) ? cData.Records : [];
        const needle = String(cName).trim().toLowerCase();
        crew = all.filter(c => String(c.FullName || '').toLowerCase().includes(needle));
      }

      if (crew.length === 0) {
        return json({ error: 'No coworkers found by that name', query: cName }, 404);
      }

      // Prefer exact (case-insensitive) if present
      const needle = String(cName).trim().toLowerCase();
      const exact = crew.find(c => String(c.FullName || '').toLowerCase() === needle);
      resolvedCoworkerId = String((exact || crew[0]).Id);
    }

    if (resolvedCoworkerId && !/^\d+$/.test(resolvedCoworkerId)) {
      return json({ error: "coworkerId must be a number. If you only have a name, use coworkerName=..." }, 400);
    }

    // Fetch bookings for today
    const params = new URLSearchParams({
      Booking_Coworker: resolvedCoworkerId,
      from_Booking_FromTime: iso(start),
      to_Booking_ToTime: iso(end),
      status: 'Confirmed',
      size: '500',
      page: '1'
    });

    const bApi = `https://spaces.nexudus.com/api/spaces/bookings?${params.toString()}&${cacheBust}`;
    const bRes = await fetch(bApi, { headers: baseHeaders(auth) });
    if (!bRes.ok) {
      return json({ error: 'Bookings fetch failed', status: bRes.status, details: await safePeek(bRes) }, 502);
    }

    const bData = await bRes.json();
    const bookings = Array.isArray(bData?.Records) ? bData.Records : [];
    return json({ bookings });
  } catch (e) {
    return json({ error: 'Server error', detail: String(e).slice(0, 400) }, 500);
  }
}

// ----------------- helpers -----------------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function baseHeaders(auth) {
  return { Authorization: auth, Accept: 'application/json' };
}

async function safePeek(res) {
  try {
    const txt = await res.text();
    return txt.slice(0, 400);
  } catch {
    return '(no body)';
  }
}

