# Harness Decoder

Identifies wire and connector part numbers on sight, reads out every field it can,
and checks Mouser and DigiKey for price and lead time.

Built around one assumption: **no lookup table will ever cover every part number.**
So identification and sourcing are decoupled. When the decoder recognises nothing,
the distributor lookup still runs on the raw string, and you still get somewhere.

## Three tiers of recognition

| Tier | What you get | Example |
|---|---|---|
| **Full** | Every field bracketed and explained | `D38999/26WD35SN`, `M22759/16-20-9`, `DT04-4P-E004` |
| **Family only** | Industry, family, and what the part is — no field parser yet | `M23053/5-103-0`, `09330062601`, `8STA6E11A98SN` |
| **None** | No signature match — straight to distributor search | anything unrecognised |

Every tier reaches the sourcing panel. That is the point.

**Field-level parsers** — D38999, MIL-DTL-5015 (MS3100/3102/3106/3108), M83513
micro-D, M39029 contacts, M85049 backshells, M22759 wire, M27500 cable, Deutsch
DT/DTM/DTP, SAE J1128 and metric ISO 6722 wire.

**Family recognition** additionally covers MS-numbered 38999, M83723, MIL-DTL-26482
and Amphenol PT, M24308, Souriau 8ST, EN 3645/2997, M81969, M22520, M23053, M83519,
M81824, M16878, M81044, Deutsch HD/HDP, AMPSEAL, Superseal, Metri-Pack, Molex
Micro-Fit and Mini-Fit, JST, HARTING Han, M12/M8, and Hirose DF.

32 signatures in total.

## Extending it

Adding a family is one entry in the `SIGNATURES` array in `public/index.html`:

```js
{ id:'m24308', ind:'Aerospace / defense', fam:'MIL-DTL-24308 D-subminiature',
  re:/^M?24308/, ref:'circular_mil',
  note:'Mil-qualified D-sub. Check whether the callout includes contacts.' }
```

Adding a field-level parser is one function returning `{ segments }`, wired to that
entry via `parse`. Signatures are matched in array order, most specific first.

There is no build step — the decoder is plain JS inline in the page. `npm test`
pulls the logic out and exercises it, so the tests still cover it.

## Run it

```bash
npm install
cp .env.example .env     # fill in what you have
npm start                # http://localhost:3000
npm test                 # decoder test suite
npm run check            # what CI runs
```

**It runs with zero API keys.** Both distributor cards degrade to search links.
Deploy it that way if you want something that cannot break in front of a visitor.

## Distributor credentials

| Vendor | Access | State of this code |
|---|---|---|
| **Mouser** | Self-serve at mouser.com/api-hub. Key arrives by email, usually same day. | Endpoint and response fields checked against Mouser's published Swagger. |
| **DigiKey** | Register an app at developer.digikey.com, subscribe it to Product Information V4, use **production** credentials — sandbox returns placeholder data. | OAuth flow and headers verified. The v4 response field names are the likeliest thing to need a tweak. |

Neither adapter has been run against a live key, so expect to adjust field names on
the first real call — DigiKey's `ProductVariations` nesting is the likeliest to
need it. `npm test` covers the normalising and every failure branch against mocked
payloads, which is as far as testing goes without credentials. `GET /api/health`
reports which credentials the running deployment can see.

DigiKey allows roughly 120 requests/minute and 1000/day on a standard app. The
server caches for 10 minutes, which keeps a public page well inside that. Raise
`TTL_MS` in `server.js` if you expect real traffic.

## Deploying

Three options, in rough order of least to most work.

### Cloudflare Pages — static site *and* live pricing

The only option here that gives you both from one deployment. Cloudflare connects
straight to a GitLab repo; `functions/api/sourcing.js` becomes `/api/sourcing`
automatically via file-based routing.

In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**,
pick the repo, then set

| Setting | Value |
|---|---|
| Build command | *(leave empty)* |
| Build output directory | `public` |

Add `MOUSER_API_KEY`, `DIGIKEY_CLIENT_ID`, and `DIGIKEY_CLIENT_SECRET` as
**encrypted** environment variables under Settings → Environment variables.

Locally: `npm run dev:cf` (needs `npx wrangler`).

Note that Cloudflare now steers new projects toward Workers with static assets
rather than Pages. Pages remains fully supported and is the lower-friction path
for a repo-connected deploy like this one; migrate later if you ever need
Workers-only features.

### GitLab Pages — static only

Zero setup beyond the `pages` job in `.gitlab-ci.yml`, since `public/` is already
the folder GitLab publishes. No backend, so both distributor cards fall back to
search links. Turn off "Use unique domain" under Deploy → Pages for a cleaner URL.

### Node host — if you want `server.js` specifically

Render, Railway, Fly, or any VPS. Set the env vars in the host dashboard rather
than committing `.env`. A `Dockerfile` is included:

```bash
docker build -t harness-decoder .
docker run -p 3000:3000 --env-file .env harness-decoder
```

`server.js` (Express) and `functions/api/sourcing.js` (Workers) are deliberate
ports of each other, not duplicates — the Workers runtime has no Express, no
`process.env`, and no long-lived module state, so the cache and secret handling
differ. Fix a bug in one, check the other.

## Before this goes on an application

**Verify the lookup tables.** Anything carrying a `verify` badge in the UI is a
value I was not confident enough to assert — finish codes, M22759 slash sheets,
M27500 basic-wire letters, insert arrangements. The data sits in one block at the
top of the script in `public/index.html`. A wrong contact rating on a site you are
showing to a harness manufacturer works against you harder than a missing one.

**Decide whether live pricing is worth the fragility.** A key that expires or
rate-limits turns into a page full of error states, and you will not be watching
when it happens. The fallback is deliberately graceful, but search-links-only is
the safest configuration for a link on an application.

## Layout

```
├── public/index.html         the entire decoder — signatures, parsers, UI
├── functions/api/            Cloudflare Pages Functions
│   ├── sourcing.js           Mouser + DigiKey proxy, edge-cached
│   └── health.js             which credentials are configured
├── server.js                 the same proxy as an Express app, for Node hosts
├── test/decode.test.mjs      detection, parser, malformed-input, registry checks
├── test/adapters.test.mjs    distributor response normalising, mocked
├── .gitlab-ci.yml            npm run check on MRs; GitLab Pages deploy
├── Dockerfile
└── .env.example
```

MIT licensed.
