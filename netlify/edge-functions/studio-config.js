import { isConfiguredTokenEndpoint } from "../../functions/api/studio-tokens.js";

const REQUIRED_SETTINGS = [
  "ANALYSIS_TOKEN_ENDPOINT",
  "REVIEWER_TOKEN_ENDPOINT",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
];

function readSettings(environment) {
  return Object.fromEntries(REQUIRED_SETTINGS.map((name) => [name, environment.get(name)]));
}

export function getNetlifyConfig(request, settings) {
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } });
  }
  const ready = isConfiguredTokenEndpoint(settings.ANALYSIS_TOKEN_ENDPOINT)
    && isConfiguredTokenEndpoint(settings.REVIEWER_TOKEN_ENDPOINT)
    && typeof settings.TURNSTILE_SITE_KEY === "string"
    && settings.TURNSTILE_SITE_KEY.length > 0
    && typeof settings.TURNSTILE_SECRET_KEY === "string"
    && settings.TURNSTILE_SECRET_KEY.length > 0;
  return Response.json(ready
    ? { mode: "hosted", siteKey: settings.TURNSTILE_SITE_KEY }
    : { mode: "not-ready" }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export default async function handler(request) {
  return getNetlifyConfig(request, readSettings(Netlify.env));
}

export const config = { path: "/api/config" };
