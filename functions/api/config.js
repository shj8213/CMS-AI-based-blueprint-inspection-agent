function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export async function onRequestGet({ env }) {
  const ready = Boolean(
    env.ANALYSIS_TOKEN_ENDPOINT
      && env.REVIEWER_TOKEN_ENDPOINT
      && env.TURNSTILE_SITE_KEY
      && env.TURNSTILE_SECRET_KEY
      && env.STUDIO_RATE_LIMITER,
  );
  return json(ready
    ? { mode: "hosted", siteKey: env.TURNSTILE_SITE_KEY }
    : { mode: "not-ready" });
}
