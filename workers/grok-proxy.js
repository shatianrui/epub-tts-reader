/**
 * Optional Cloudflare Worker proxy for Grok / xAI TTS.
 * Deploy: npx wrangler deploy workers/grok-proxy.js
 *
 * In 听页 settings, set「API 地址」to your worker origin, e.g.
 *   https://listenpage-grok-proxy.<you>.workers.dev
 */
export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(request) });
    }

    const incoming = new URL(request.url);
    const target = `https://api.x.ai${incoming.pathname}${incoming.search}`;
    const headers = new Headers(request.headers);
    headers.delete("host");

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
    });

    const outHeaders = new Headers(upstream.headers);
    cors(request).forEach((v, k) => outHeaders.set(k, v));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  },
};

function cors(request) {
  const origin = request.headers.get("Origin") || "*";
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization,Content-Type,Range,X-Requested-With",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
}
