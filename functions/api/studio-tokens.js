const ENDPOINT_PATH = /^\/(?:copilotstudio\/agenticruntime|powervirtualagents)\/botsbyschema\/[^/]+\/directline\/token$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function validTokenEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    || !url.hostname.endsWith(".environment.api.powerplatform.com")
    || url.port
    || url.username
    || url.password
    || url.hash
    || !ENDPOINT_PATH.test(url.pathname)
    || !url.searchParams.get("api-version")
    || [...url.searchParams.keys()].some((key) => key !== "api-version")
  ) return null;
  return url;
}

export function isConfiguredTokenEndpoint(value) {
  return validTokenEndpoint(value) !== null;
}

function validDirectLineBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const trustedHost = url.hostname === "directline.botframework.com"
    || url.hostname.endsWith(".directline.botframework.com");
  if (url.protocol !== "https:" || !trustedHost || url.port || url.username || url.password) return null;
  return new URL("/v3/directline/", url);
}

async function readJsonBody(request) {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > 8192) return { tooLarge: true };
  const reader = request.body?.getReader();
  if (!reader) return { invalid: true };
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 8192) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { invalid: true };
  }
}

async function getAgentAccess(endpointValue, fetchImpl) {
  const endpoint = validTokenEndpoint(endpointValue);
  if (!endpoint) throw new Error("invalid-agent-endpoint");
  const regionUrl = new URL("/powervirtualagents/regionalchannelsettings", endpoint.origin);
  regionUrl.searchParams.set("api-version", endpoint.searchParams.get("api-version"));
  const [tokenResponse, regionResponse] = await Promise.all([
    fetchImpl(endpoint, { redirect: "error", cache: "no-store" }),
    fetchImpl(regionUrl, { redirect: "error", cache: "no-store" }),
  ]);
  if (!tokenResponse.ok || !regionResponse.ok) throw new Error("agent-connection-failed");
  const [tokenData, regionData] = await Promise.all([tokenResponse.json(), regionResponse.json()]);
  if (typeof tokenData?.token !== "string" || !tokenData.token) throw new Error("agent-token-missing");
  const directLineBase = validDirectLineBase(regionData?.channelUrlsById?.directline);
  if (!directLineBase) throw new Error("agent-region-invalid");
  return { token: tokenData.token, directLineBase: directLineBase.href };
}

async function verifyTurnstile(token, secret, ip, hostname, fetchImpl) {
  const body = new URLSearchParams({ secret, response: token, remoteip: ip });
  const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) return false;
  const result = await response.json();
  return result.success === true
    && result.hostname === hostname
    && result.action === "studio-connect";
}

export async function issueStudioToken(
  request,
  env,
  fetchImpl = fetch,
  { clientIp = null, rateLimitVerified = false } = {},
) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("Origin");
  try {
    if (!origin || new URL(origin).origin !== requestUrl.origin) return json({ error: "origin-not-allowed" }, 403);
  } catch {
    return json({ error: "origin-not-allowed" }, 403);
  }
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") {
    return json({ error: "json-required" }, 415);
  }
  const ip = clientIp ?? request.headers.get("CF-Connecting-IP");
  if (!ip || ip.length > 64) return json({ error: "request-not-allowed" }, 403);
  if (!rateLimitVerified) {
    if (!env.STUDIO_RATE_LIMITER) return json({ error: "service-not-ready" }, 503);
    try {
      const limited = await env.STUDIO_RATE_LIMITER.limit({ key: ip });
      if (!limited.success) return json({ error: "rate-limited" }, 429);
    } catch {
      return json({ error: "service-not-ready" }, 503);
    }
  }
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) {
    return json({ error: "service-not-ready" }, 503);
  }

  const parsed = await readJsonBody(request);
  if (parsed.tooLarge) return json({ error: "request-too-large" }, 413);
  if (parsed.invalid) return json({ error: "invalid-request" }, 400);
  const input = parsed.value;
  if (
    !["analysis", "reviewer"].includes(input?.agent)
    || typeof input.turnstileToken !== "string"
    || !input.turnstileToken
    || input.turnstileToken.length > 4096
  ) {
    return json({ error: "challenge-required" }, 400);
  }
  try {
    if (!await verifyTurnstile(input.turnstileToken, env.TURNSTILE_SECRET_KEY, ip, requestUrl.hostname, fetchImpl)) {
      return json({ error: "challenge-failed" }, 403);
    }
    const endpoint = input.agent === "analysis"
      ? env.ANALYSIS_TOKEN_ENDPOINT
      : env.REVIEWER_TOKEN_ENDPOINT;
    if (!endpoint) return json({ error: "service-not-ready" }, 503);
    return json(await getAgentAccess(endpoint, fetchImpl));
  } catch {
    return json({ error: "agent-connection-failed" }, 502);
  }
}

export async function onRequestPost({ request, env }) {
  return issueStudioToken(request, env);
}
