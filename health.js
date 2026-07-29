/** Reports which distributor credentials the deployment can see. */
export async function onRequestGet({ env }) {
  return Response.json({
    ok: true,
    runtime: 'cloudflare-pages-functions',
    configured: {
      mouser: !!env.MOUSER_API_KEY,
      digikey: !!(env.DIGIKEY_CLIENT_ID && env.DIGIKEY_CLIENT_SECRET)
    }
  });
}
