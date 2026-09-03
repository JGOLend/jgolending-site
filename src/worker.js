// Server-side Meta Conversions API relay for the development finance quiz.
//
// Why this exists: the browser pixel fires 'Lead' at the very last moment of
// the interaction, right as the visitor sees the confirmation screen and is
// most likely to close the tab. If the browser tears the page down before
// that network call completes, the event is silently lost - no error either
// side. This route re-sends the same event from Cloudflare's servers, which
// cannot be interrupted by a closed tab, using the eventID the client
// already generated so Meta deduplicates the two into one conversion.
//
// META_CAPI_TOKEN is a Cloudflare Worker secret (Settings > Variables and
// Secrets in the dashboard) - it must never be committed to source or sent
// to the browser.

const META_PIXEL_ID = "1427947952531869";
const GRAPH_API_VERSION = "v21.0";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/lead" && request.method === "POST") {
      return handleLead(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

async function handleLead(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  if (!env.META_CAPI_TOKEN) {
    // Secret not configured yet - fail quietly so a lead submission is
    // never blocked by tracking infrastructure. Visible in Worker logs.
    console.error("META_CAPI_TOKEN secret is not set");
    return jsonResponse({ ok: false, error: "capi_not_configured" }, 200);
  }

  const eventId = typeof payload.event_id === "string" && payload.event_id
    ? payload.event_id
    : crypto.randomUUID();

  const qualified = payload.amount !== "Under $3m";
  const eventName = qualified ? "Lead" : "LeadBelowFloor";

  const userData = {};
  if (payload.email) userData.em = [await sha256Hex(normalizeEmail(payload.email))];
  if (payload.phone) userData.ph = [await sha256Hex(normalizePhone(payload.phone))];

  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) userData.client_ip_address = clientIp;
  const userAgent = request.headers.get("User-Agent");
  if (userAgent) userData.client_user_agent = userAgent;

  const cookieHeader = request.headers.get("Cookie") || "";
  const fbp = readCookie(cookieHeader, "_fbp");
  const fbc = readCookie(cookieHeader, "_fbc");
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    event_source_url: typeof payload.page_url === "string" ? payload.page_url : undefined,
    action_source: "website",
    user_data: userData,
    custom_data: {
      content_name: "Commercial development finance quiz",
      content_category: qualified ? "qualified" : "below_floor"
    }
  };

  const graphUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN)}`;

  try {
    const fbResponse = await fetch(graphUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [event] })
    });
    const fbResult = await fbResponse.json();
    if (!fbResponse.ok) {
      console.error("Meta CAPI error", JSON.stringify(fbResult));
      return jsonResponse({ ok: false, error: "capi_rejected" }, 200);
    }
    return jsonResponse({ ok: true, event_id: eventId }, 200);
  } catch (e) {
    console.error("Meta CAPI request failed", e.message);
    return jsonResponse({ ok: false, error: "capi_request_failed" }, 200);
  }
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

function normalizePhone(phone) {
  // Digits only. Meta expects country code included; this page's audience
  // is Australian and the quiz doesn't collect a country code, so this
  // matches on best-effort digits rather than a strict E.164 conversion.
  return String(phone).replace(/[^0-9]/g, "");
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[1]) : null;
}
