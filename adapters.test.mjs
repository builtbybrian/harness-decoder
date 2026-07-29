/**
 * Exercises the Mouser and DigiKey response normalisers against representative
 * payloads.
 *
 * These cannot prove the field names match what the live APIs return — that
 * needs a real key. What they do prove is that once a payload of this shape
 * arrives, it comes out the far side correctly, and that every failure mode
 * degrades to a reason string instead of throwing. The adapters take an
 * injectable fetch precisely so this is testable.
 */

import { mouser, digikey, parsePrice, __resetTokenCache } from '../functions/api/sourcing.js';

let failures = 0;
const fail = (m) => { console.error('  FAIL  ' + m); failures++; };
const eq = (got, want, label) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) fail(`${label}: got ${a}, expected ${b}`);
};

const fakeFetch = (status, body) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

/* ── Mouser ─────────────────────────────────────────────────────────────── */

console.log('mouser');

const mouserPayload = {
  Errors: [],
  SearchResults: {
    Parts: [{
      MouserPartNumber: '571-M39029-56-348',
      ManufacturerPartNumber: 'M39029/56-348',
      Manufacturer: 'TE Connectivity',
      Description: 'Socket contact, size 22D, crimp',
      AvailabilityInStock: '4,215',
      LeadTime: '28 Days',
      PriceBreaks: [
        { Quantity: 1,   Price: '$2.15',  Currency: 'USD' },
        { Quantity: 100, Price: '$1.87',  Currency: 'USD' },
        { Quantity: 500, Price: '$1.４2', Currency: 'USD' }   // deliberately malformed
      ],
      ProductDetailUrl: 'https://www.mouser.com/ProductDetail/571-M39029-56-348',
      DataSheetUrl: 'https://example.com/ds.pdf'
    }]
  }
};

{
  const r = await mouser('M39029/56-348', { MOUSER_API_KEY: 'x' }, fakeFetch(200, mouserPayload));
  if (!r.ok) fail('valid payload did not return ok');
  eq(r.part.stock, 4215, 'stock strips the thousands separator');
  eq(r.part.leadTime, '28 Days', 'lead time');
  eq(r.part.priceBreaks.length, 2, 'malformed price break is dropped, not passed through as NaN');
  eq(r.part.priceBreaks[0], { qty: 1, price: 2.15, currency: 'USD' }, 'price parsed out of display string');
  eq(r.part.sku, '571-M39029-56-348', 'sku');
}

{
  const r = await mouser('X', {}, fakeFetch(200, mouserPayload));
  eq(r, { ok: false, reason: 'No API key' }, 'missing key');
}
{
  const r = await mouser('X', { MOUSER_API_KEY: 'x' }, fakeFetch(403, {}));
  eq(r, { ok: false, reason: 'HTTP 403' }, 'http error');
}
{
  const r = await mouser('X', { MOUSER_API_KEY: 'x' },
    fakeFetch(200, { Errors: [{ Message: 'Invalid API key' }] }));
  eq(r, { ok: false, reason: 'Invalid API key' }, 'api-level error surfaces its message');
}
{
  const r = await mouser('X', { MOUSER_API_KEY: 'x' }, fakeFetch(200, { SearchResults: { Parts: [] } }));
  eq(r, { ok: false, reason: 'Not stocked' }, 'empty result set');
}
{
  const r = await mouser('X', { MOUSER_API_KEY: 'x' }, async () => { throw new Error('boom'); });
  eq(r, { ok: false, reason: 'Unreachable' }, 'network failure does not throw');
}
{
  // no PriceBreaks / no stock fields at all
  const r = await mouser('X', { MOUSER_API_KEY: 'x' },
    fakeFetch(200, { SearchResults: { Parts: [{ MouserPartNumber: 'A' }] } }));
  if (!r.ok) fail('sparse part should still normalise');
  eq(r.part.stock, 0, 'absent stock becomes 0');
  eq(r.part.priceBreaks, [], 'absent price breaks become []');
  eq(r.part.leadTime, null, 'absent lead time becomes null');
}

/* ── price parsing ──────────────────────────────────────────────────────── */

console.log('price parsing');
for (const [input, want] of [
  ['$12.34', 12.34], ['12.34', 12.34], ['$1,234.56', 1234.56], ['£9.99', 9.99],
  [2.5, 2.5], ['$1.４2', null], ['n/a', null], ['', null], [null, null], ['$', null]
]) {
  eq(parsePrice(input), want, `parsePrice(${JSON.stringify(input)})`);
}

/* ── DigiKey ────────────────────────────────────────────────────────────── */

console.log('digikey');

const dkEnv = { DIGIKEY_CLIENT_ID: 'id', DIGIKEY_CLIENT_SECRET: 'secret' };

// First call is the token endpoint, second is the search.
function dkFetch(searchStatus, searchBody, tokenOk = true) {
  let n = 0;
  return async () => {
    n++;
    if (n === 1) return { ok: tokenOk, status: tokenOk ? 200 : 401,
      json: async () => ({ access_token: 't', expires_in: 1800 }) };
    return { ok: searchStatus >= 200 && searchStatus < 300, status: searchStatus,
      json: async () => searchBody };
  };
}

const dkPayload = {
  Products: [{
    ManufacturerProductNumber: 'M39029/56-348',
    Manufacturer: { Name: 'TE Connectivity' },
    Description: { ProductDescription: 'CONTACT SOCKET 22AWG CRIMP GOLD' },
    QuantityAvailable: 1820,
    ProductUrl: 'https://www.digikey.com/en/products/detail/xyz',
    DatasheetUrl: 'https://example.com/dk.pdf',
    ProductVariations: [
      { DigiKeyProductNumber: 'A1-CT',   QuantityAvailableforPackageType: 12,
        ManufacturerLeadWeeks: '14', StandardPricing: [{ BreakQuantity: 1, UnitPrice: 3.10 }] },
      { DigiKeyProductNumber: 'A1-TR',   QuantityAvailableforPackageType: 1808,
        ManufacturerLeadWeeks: '12',
        StandardPricing: [{ BreakQuantity: 1, UnitPrice: 2.90 }, { BreakQuantity: 100, UnitPrice: 2.40 }] }
    ]
  }]
};

{
  __resetTokenCache();
  const r = await digikey('M39029/56-348', dkEnv, dkFetch(200, dkPayload));
  if (!r.ok) fail('valid payload did not return ok');
  eq(r.part.sku, 'A1-TR', 'picks the best-stocked variation, not the first');
  eq(r.part.leadTime, '12 wks', 'lead weeks formatted from the chosen variation');
  eq(r.part.stock, 1820, 'top-level stock preferred');
  eq(r.part.priceBreaks.length, 2, 'price breaks from the chosen variation');
  eq(r.part.priceBreaks[1], { qty: 100, price: 2.40, currency: 'USD' }, 'second break');
}

{
  __resetTokenCache();
  const r = await digikey('X', {}, dkFetch(200, dkPayload));
  eq(r, { ok: false, reason: 'No credentials' }, 'missing credentials');
}
{
  __resetTokenCache();
  const r = await digikey('X', dkEnv, dkFetch(429, {}));
  eq(r, { ok: false, reason: 'Rate limited' }, 'rate limit is distinguished from a generic error');
}
{
  __resetTokenCache();
  const r = await digikey('X', dkEnv, dkFetch(401, {}));
  eq(r, { ok: false, reason: 'Auth expired' }, 'auth expiry is distinguished');
}
{
  __resetTokenCache();
  const r = await digikey('X', dkEnv, dkFetch(200, { Products: [] }));
  eq(r, { ok: false, reason: 'Not stocked' }, 'empty result set');
}
{
  __resetTokenCache();
  const r = await digikey('X', dkEnv, dkFetch(200, dkPayload, false));
  eq(r, { ok: false, reason: 'Unreachable' }, 'token failure does not throw');
}
{
  // product with no variations at all
  const r = await digikey('X', dkEnv, dkFetch(200, { Products: [{ ManufacturerProductNumber: 'B' }] }));
  if (!r.ok) fail('sparse product should still normalise');
  eq(r.part.priceBreaks, [], 'absent variations become []');
  eq(r.part.leadTime, null, 'absent lead weeks become null');
}

console.log('');
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('all adapter checks passed');
