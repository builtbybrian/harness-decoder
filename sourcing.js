/**
 * Cloudflare Pages Function — distributor sourcing proxy.
 * File-based routing puts this at /api/sourcing, which is what the page calls.
 *
 * This is a port of server.js, not a copy. The Workers runtime is not Node:
 *   · no express, no fs, no path
 *   · secrets arrive on context.env, not process.env
 *   · module scope is per-isolate and short-lived, so the Map cache from the
 *     Node version is replaced with the edge Cache API
 *
 * Behaviour is otherwise identical, including the part that matters most:
 * a distributor being down, rate-limited, or unconfigured degrades that one
 * card to a search link and never takes the page with it.
 */

const TTL_SECONDS = 600;

const miss = (reason) => ({ ok: false, reason });

/**
 * Mouser returns price as a display string ("$12.34", "$1,234.56").
 * Stripping every non-digit is tempting and wrong: it turns a corrupted value
 * into a plausible-looking wrong number rather than rejecting it. Anything that
 * does not cleanly match a price after removing currency symbols, whitespace,
 * and thousands separators is dropped instead.
 */
export function parsePrice(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(/[$£€\s]/g, '').replace(/,(?=\d{3}\b)/g, '');
  return /^\d+(\.\d+)?$/.test(stripped) ? parseFloat(stripped) : null;
}

/** Workers supports AbortController; this keeps a slow distributor from
 *  holding the whole response hostage. */
function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

/* ── Mouser ────────────────────────────────────────────────────────────── */

export async function mouser(q, env, fetchImpl = fetch) {
  const key = env.MOUSER_API_KEY;
  if (!key) return miss('No API key');

  const t = withTimeout(6000);
  try {
    const r = await fetchImpl(
      `https://api.mouser.com/api/v1/search/partnumber?apiKey=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          SearchByPartRequest: { mouserPartNumber: q, partSearchOptions: 'Exact' }
        }),
        signal: t.signal
      }
    );
    if (!r.ok) return miss(`HTTP ${r.status}`);
    const j = await r.json();

    if (j.Errors?.length) return miss(j.Errors[0].Message || 'API error');
    const p = j.SearchResults?.Parts?.[0];
    if (!p) return miss('Not stocked');

    return {
      ok: true,
      part: {
        sku: p.MouserPartNumber,
        mpn: p.ManufacturerPartNumber,
        manufacturer: p.Manufacturer,
        description: p.Description,
        stock: parseInt(String(p.AvailabilityInStock ?? p.Availability ?? '').replace(/\D/g, ''), 10) || 0,
        leadTime: p.LeadTime || null,
        priceBreaks: (p.PriceBreaks || [])
          .map(b => ({ qty: b.Quantity, price: parsePrice(b.Price), currency: b.Currency || 'USD' }))
          .filter(b => b.price !== null),
        url: p.ProductDetailUrl,
        datasheet: p.DataSheetUrl || null
      }
    };
  } catch (e) {
    return miss(e.name === 'AbortError' ? 'Timed out' : 'Unreachable');
  } finally { t.done(); }
}

/* ── DigiKey ───────────────────────────────────────────────────────────── */

// Per-isolate. Isolates are short-lived, so treat this as opportunistic —
// a cold start just costs one extra token call.
let dkToken = { value: null, exp: 0 };

/** Exported for tests. The cache is per-isolate state, and state that cannot be
 *  cleared is state that cannot be tested. */
export function __resetTokenCache() { dkToken = { value: null, exp: 0 }; }

async function digikeyToken(env, fetchImpl) {
  if (dkToken.value && Date.now() < dkToken.exp - 60_000) return dkToken.value;

  const r = await fetchImpl('https://api.digikey.com/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DIGIKEY_CLIENT_ID,
      client_secret: env.DIGIKEY_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  if (!r.ok) throw new Error(`token HTTP ${r.status}`);
  const j = await r.json();
  dkToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 1800) * 1000 };
  return dkToken.value;
}

export async function digikey(q, env, fetchImpl = fetch) {
  if (!env.DIGIKEY_CLIENT_ID || !env.DIGIKEY_CLIENT_SECRET) return miss('No credentials');

  const t = withTimeout(8000);
  try {
    const token = await digikeyToken(env, fetchImpl);
    const r = await fetchImpl('https://api.digikey.com/products/v4/search/keyword', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-DIGIKEY-Client-Id': env.DIGIKEY_CLIENT_ID,
        'X-DIGIKEY-Locale-Site': env.DIGIKEY_SITE || 'US',
        'X-DIGIKEY-Locale-Language': 'en',
        'X-DIGIKEY-Locale-Currency': env.DIGIKEY_CURRENCY || 'USD',
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ Keywords: q, Limit: 5, Offset: 0 }),
      signal: t.signal
    });
    if (r.status === 401) { dkToken = { value: null, exp: 0 }; return miss('Auth expired'); }
    if (r.status === 429) return miss('Rate limited');
    if (!r.ok) return miss(`HTTP ${r.status}`);

    const j = await r.json();
    const prod = j.Products?.[0];
    if (!prod) return miss('Not stocked');

    // v4 nests purchasable SKUs under ProductVariations; take the best-stocked.
    const best = (prod.ProductVariations || []).slice().sort(
      (a, b) => (b.QuantityAvailableforPackageType || 0) - (a.QuantityAvailableforPackageType || 0)
    )[0] || {};

    const weeks = best.ManufacturerLeadWeeks || prod.ManufacturerLeadWeeks || null;

    return {
      ok: true,
      part: {
        sku: best.DigiKeyProductNumber || prod.ManufacturerProductNumber,
        mpn: prod.ManufacturerProductNumber,
        manufacturer: prod.Manufacturer?.Name,
        description: prod.Description?.ProductDescription,
        stock: prod.QuantityAvailable ?? best.QuantityAvailableforPackageType ?? 0,
        leadTime: weeks ? `${weeks} wks` : null,
        priceBreaks: (best.StandardPricing || []).map(b => ({
          qty: b.BreakQuantity,
          price: b.UnitPrice,
          currency: env.DIGIKEY_CURRENCY || 'USD'
        })),
        url: prod.ProductUrl || best.ProductUrl,
        datasheet: prod.DatasheetUrl || null
      }
    };
  } catch (e) {
    return miss(e.name === 'AbortError' ? 'Timed out' : 'Unreachable');
  } finally { t.done(); }
}

/* ── handler ───────────────────────────────────────────────────────────── */

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 80);

  if (!q) {
    return Response.json({ error: 'Give a part number in ?q=' }, { status: 400 });
  }

  // Edge cache, keyed on the normalised query rather than the raw URL so that
  // case and whitespace variants share an entry.
  const cacheKey = new Request(
    `${url.origin}/api/sourcing?q=${encodeURIComponent(q.toUpperCase())}`,
    { method: 'GET' }
  );
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.json();
    return Response.json({ ...body, cached: true });
  }

  const [m, d] = await Promise.allSettled([mouser(q, env), digikey(q, env)]);
  const unwrap = r => (r.status === 'fulfilled' ? r.value : miss('Adapter error'));

  const payload = { query: q, cached: false, results: { mouser: unwrap(m), digikey: unwrap(d) } };

  const response = Response.json(payload, {
    headers: { 'Cache-Control': `public, max-age=${TTL_SECONDS}` }
  });

  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
