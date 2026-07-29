/**
 * Harness Decoder — distributor sourcing proxy
 *
 * Why this exists: both Mouser and DigiKey require credentials, and neither permits
 * browser-direct calls. The keys stay here; the page calls this.
 *
 * Every adapter is expected to fail. A distributor being down, rate-limited, or
 * unconfigured degrades that one card to a search link — it never takes the page
 * with it. That is why this uses allSettled and normalises every branch.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

/* ── cache ────────────────────────────────────────────────────────────────
   Distributor pricing moves slowly and their rate limits are tight —
   DigiKey allows roughly 120 req/min and 1000 req/day on a standard app.
   Ten minutes of caching keeps a demo page well inside that.            */

const TTL_MS = 10 * 60 * 1000;
const cache = new Map();

const cacheGet = k => {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { cache.delete(k); return null; }
  return hit.value;
};
const cacheSet = (k, value) => {
  cache.set(k, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
};

const timeout = (ms) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
};

/* ── normalised shape every adapter returns ───────────────────────────────
   { ok, reason?, part: { sku, mpn, manufacturer, description,
                          stock, leadTime, priceBreaks:[{qty,price,currency}],
                          url, datasheet } }                              */

const miss = reason => ({ ok: false, reason });

/**
 * Mouser returns price as a display string ("$12.34", "$1,234.56").
 * Stripping every non-digit is tempting and wrong: it turns a corrupted value
 * into a plausible-looking wrong number rather than rejecting it. Anything that
 * does not cleanly match a price is dropped instead.
 */
export function parsePrice(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(/[$£€\s]/g, '').replace(/,(?=\d{3}\b)/g, '');
  return /^\d+(\.\d+)?$/.test(stripped) ? parseFloat(stripped) : null;
}

/* ── Mouser ───────────────────────────────────────────────────────────────
   Search API v1. Key is a query parameter. Verified against Mouser's
   published Swagger (api.mouser.com/api/docs/V1).                        */

async function mouser(q) {
  const key = process.env.MOUSER_API_KEY;
  if (!key) return miss('No API key');

  const t = timeout(6000);
  try {
    const r = await fetch(
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

/* ── DigiKey ──────────────────────────────────────────────────────────────
   Product Information v4, two-legged OAuth (client_credentials).
   Token endpoint and header names verified against DigiKey's developer
   portal; the response field names below are the v4 shape and are the most
   likely thing to need adjustment if DigiKey revises the schema.         */

let dkToken = { value: null, exp: 0 };

async function digikeyToken() {
  if (dkToken.value && Date.now() < dkToken.exp - 60_000) return dkToken.value;

  const r = await fetch('https://api.digikey.com/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.DIGIKEY_CLIENT_ID,
      client_secret: process.env.DIGIKEY_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  if (!r.ok) throw new Error(`token HTTP ${r.status}`);
  const j = await r.json();
  dkToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 1800) * 1000 };
  return dkToken.value;
}

async function digikey(q) {
  if (!process.env.DIGIKEY_CLIENT_ID || !process.env.DIGIKEY_CLIENT_SECRET) {
    return miss('No credentials');
  }

  const t = timeout(8000);
  try {
    const token = await digikeyToken();
    const r = await fetch('https://api.digikey.com/products/v4/search/keyword', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-DIGIKEY-Client-Id': process.env.DIGIKEY_CLIENT_ID,
        'X-DIGIKEY-Locale-Site': process.env.DIGIKEY_SITE || 'US',
        'X-DIGIKEY-Locale-Language': 'en',
        'X-DIGIKEY-Locale-Currency': process.env.DIGIKEY_CURRENCY || 'USD',
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
    const variations = prod.ProductVariations || [];
    const best = variations.slice().sort(
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
          currency: process.env.DIGIKEY_CURRENCY || 'USD'
        })),
        url: prod.ProductUrl || best.ProductUrl,
        datasheet: prod.DatasheetUrl || null
      }
    };
  } catch (e) {
    return miss(e.name === 'AbortError' ? 'Timed out' : 'Unreachable');
  } finally { t.done(); }
}

/* ── route ────────────────────────────────────────────────────────────── */

app.get('/api/sourcing', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (!q) return res.status(400).json({ error: 'Give a part number in ?q=' });

  const key = q.toUpperCase();
  const hit = cacheGet(key);
  if (hit) return res.json({ query: q, cached: true, results: hit });

  const [m, d] = await Promise.allSettled([mouser(q), digikey(q)]);
  const unwrap = r => (r.status === 'fulfilled' ? r.value : miss('Adapter error'));

  const results = { mouser: unwrap(m), digikey: unwrap(d) };
  cacheSet(key, results);
  res.json({ query: q, cached: false, results });
});

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  configured: {
    mouser: !!process.env.MOUSER_API_KEY,
    digikey: !!(process.env.DIGIKEY_CLIENT_ID && process.env.DIGIKEY_CLIENT_SECRET)
  }
}));

app.listen(PORT, () => console.log(`Harness Decoder on http://localhost:${PORT}`));
