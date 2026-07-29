/**
 * Worker entry point.
 *
 * Cloudflare's git integration now deploys repositories as Workers rather than
 * Pages projects, and Workers do not use the functions/ file-based routing that
 * Pages does. This file provides the routing explicitly, reusing the same
 * handlers so the two deployment targets cannot drift apart.
 *
 * Anything that is not an API route falls through to the static assets binding,
 * which serves public/.
 */

import { onRequestGet as sourcing } from './functions/api/sourcing.js';
import { onRequestGet as health } from './functions/api/health.js';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    // Pages Functions receive a context object; build the equivalent here.
    const context = { request, env, waitUntil: ctx.waitUntil.bind(ctx) };

    if (pathname === '/api/sourcing') return sourcing(context);
    if (pathname === '/api/health') return health(context);

    return env.ASSETS.fetch(request);
  }
};
