/**
 * Hands the game short-lived Cloudflare TURN credentials, so players on
 * different networks can relay a match when a direct WebRTC link cannot get
 * through both routers. The TURN key stays here as a Worker secret; a browser
 * only ever sees credentials that expire.
 *
 *   npx wrangler secret put TURN_KEY_ID
 *   npx wrangler secret put TURN_KEY_API_TOKEN
 *   npx wrangler deploy
 */
const ALLOWED = ['https://st3d.roytown.net', 'https://smugglers-town-3d.web.app', 'http://localhost:5173'];
// longer than any match, shorter than a leaked credential should live
const TTL_S = 4 * 3600;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') ?? '';
    // a speed bump, not a lock: non-browsers can send any Origin
    if (!ALLOWED.includes(origin)) return new Response('forbidden', { status: 403 });
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_S })
      }
    );
    if (!res.ok) return new Response('turn unavailable', { status: 502, headers: cors });
    return new Response(await res.text(), { headers: { ...cors, 'Content-Type': 'application/json' } });
  }
};
