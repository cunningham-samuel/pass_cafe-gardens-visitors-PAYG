export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);

    const type = (url.searchParams.get('type') || '').toLowerCase(); // 'visitor' | 'coworker'
    if (!['visitor', 'coworker'].includes(type)) {
      return json({ error: "Missing or invalid 'type'. Use type=visitor or type=coworker." }, 400);
    }

    // Accept specific or generic name params
    const name =
      url.searchParams.get(type === 'visitor' ? 'visitorName' : 'coworkerName') ||
      url.searchParams.get('name') ||
      '';

    if (!name.trim()) {
      return json({ error: "Missing name. Use 'visitorName=' or 'coworkerName=' (or 'name=' with type=...)" }, 400);
    }

    const auth = "Basic " + btoa(`${env.NEXUDUS_API_USERNAME}:${env.NEXUDUS_API_PASSWORD}`);

    // --- Build today's UTC window in Nexudus expected "YYYY-MM-DDTHH:mm" (no seconds) ---
    const now = new Date();
    const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
    const end   = new Date(now); end.setUTCHours(23, 59, 59, 999);

    const fmtMinuteUTC = (d) => {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      return `${y}-${m}-${day}T${hh}:${mm}`;
    };

    const fromStr = fmtMinuteUTC(start);
    const toStr   = fmtMinuteUTC(end);

    // Helper: booking is "current" with small grace
    const isCurrent = (b, marginMin = 15) => {
      try {
        const from = new Date(b.FromTime);
        const to = new Date(b.ToTime);
        const startMargin = new Date(from.getTime() - marginMin * 60000);
        const endMargin = new Date(to.getTime() + marginMin * 60000);
        return now >= startMargin && now <= endMargin;
      } catch {
        return false;
      }
    };

    // Helper: choose latest by ToTime
    const pickLatestByEnd = (arr) =>
      arr
        .slice()
        .sort((a, b) => new Date(b.ToTime) - new Date(a.ToTime))[0];

    // Helper: simple fuzzy match (case-insensitive; includes; small edit distance)
    const fuzzyMatch = (haystackName, needleName) => {
      const a = normalizeName(haystackName);
      const b = normalizeName(needleName);
      if (!a || !b) return false;

      if (a.includes(b) || b.includes(a)) return true;

      // try token order-insensitive match
      const aTokens = a.split(' ').filter(Boolean);
      const bTokens = b.split(' ').filter(Boolean);
      const allBInA = bTokens.every(bt => aTokens.some(at => at.includes(bt)));
      if (allBInA) return true;

      // small edit distance allowance on full string
      const dist = editDistance(a, b);
      const maxAllowed = b.length <= 5 ? 1 : b.length <= 8 ? 2 : 3;
      return dist <= maxAllowed;
    };

    // ---------- CO-WORKER FLOW (bookings by name) ----------
    if (type === 'coworker') {
      // Fetch today's bookings (page through, then match on CoworkerFullName)
      const bookings = await fetchAllPages(
        'https://spaces.nexudus.com/api/spaces/bookings',
        {
          page: '1',
          size: '500',
          from_Booking_FromTime: fromStr,
          to_Booking_ToTime: toStr
        },
        auth
      );

      // Fuzzy match coworker full name
      const matched = bookings.filter(b =>
        fuzzyMatch(b.CoworkerFullName || '', name)
      );

      // Keep current only
      const current = matched.filter(isCurrent);

      if (current.length === 0) {
        return json({ bookings: [], message: 'No current bookings found for that name.' }, 404);
      }

      const chosen = pickLatestByEnd(current);
      return json({ bookings: [chosen], matches: current.length });
    }

    // ---------- VISITOR FLOW ----------
    // 1) Fetch all booking visitors (page through) and fuzzy-match VisitorFullName
    const bookingVisitors = await fetchAllPages(
      'https://spaces.nexudus.com/api/spaces/bookingvisitors',
      { page: '1', size: '500' },
      auth
    );

    const matchedVisitors = bookingVisitors.filter(v =>
      fuzzyMatch(v.VisitorFullName || '', name)
    );

    if (matchedVisitors.length === 0) {
      return json({ error: 'No visitors found by that name.' }, 404);
    }

    // 2) Fetch today's bookings once and index by Id
    const todaysBookings = await fetchAllPages(
      'https://spaces.nexudus.com/api/spaces/bookings',
      {
        page: '1',
        size: '500',
        from_Booking_FromTime: fromStr,
        to_Booking_ToTime: toStr
      },
      auth
    );

    const byId = new Map(todaysBookings.map(b => [b.Id, b]));

    // 3) Join matches to current bookings by BookingId
    const joined = [];
    for (const v of matchedVisitors) {
      const b = byId.get(v.BookingId);
      if (b && isCurrent(b)) {
        joined.push({ visitor: v, booking: b });
      }
    }

    if (joined.length === 0) {
      return json({ error: 'No current booking found for that visitor.' }, 404);
    }

    // 4) If multiple, choose latest booking.ToTime
    const chosen = joined
      .slice()
      .sort((a, b) => new Date(b.booking.ToTime) - new Date(a.booking.ToTime))[0];

    // Return both pieces so the web pass can render details similar to the member pass
    return json({
      visitor: chosen.visitor,
      booking: chosen.booking,
      matches: joined.length
    });

  } catch (e) {
    return json({ error: 'Server error', detail: String(e).slice(0, 400) }, 500);
  }
}

/* ---------------- helpers ---------------- */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function baseHeaders(auth) {
  return { Authorization: auth, Accept: 'application/json' };
}

// Paginate until no next page (caps at 10 pages to be safe)
async function fetchAllPages(baseUrl, paramsObj, auth, pageCap = 10) {
  let page = 1;
  let results = [];
  while (page <= pageCap) {
    const params = new URLSearchParams({ ...paramsObj, page: String(page) });
    const url = `${baseUrl}?${params.toString()}&t=${Date.now()}`;
    const res = await fetch(url, { headers: baseHeaders(auth) });
    if (!res.ok) {
      const peek = await safePeek(res);
      throw new Error(`Fetch failed ${res.status} at ${baseUrl} p${page}: ${peek}`);
    }
    const data = await res.json();
    const records = Array.isArray(data?.Records) ? data.Records : [];
    results = results.concat(records);

    // Nexudus pagination flags
    const hasNext = !!data?.HasNextPage || (data?.PageNumber && data?.TotalPages && data.PageNumber < data.TotalPages);
    if (!hasNext) break;
    page += 1;
  }
  return results;
}

async function safePeek(res) {
  try {
    const txt = await res.text();
    return txt.slice(0, 400);
  } catch {
    return '(no body)';
  }
}

// --- fuzzy helpers ---
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9\s]/g, ' ') // keep letters/numbers/spaces
    .replace(/\s+/g, ' ')
    .trim();
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}
