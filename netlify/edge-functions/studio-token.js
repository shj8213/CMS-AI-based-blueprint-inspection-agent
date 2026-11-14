import { issueStudioToken } from "../../functions/api/studio-tokens.js";

const REQUIRED_SETTINGS = [
  "ANALYSIS_TOKEN_ENDPOINT",
  "REVIEWER_TOKEN_ENDPOINT",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
];

function readSettings(environment) {
  return Object.fromEntries(REQUIRED_SETTINGS.map((name) => [name, environment.get(name)]));
}

export async function handleNetlifyStudioToken(request, context, settings, fetchImpl = fetch) {
  if (request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { Allow: "POST", "Cache-Control": "no-store" },
    });
  }
  return issueStudioToken(request, settings, fetchImpl, {
    clientIp: context.ip,
    rateLimitVerified: true,
  });
}

export default async function handler(request, context) {
  return handleNetlifyStudioToken(request, context, readSettings(Netlify.env));
}

export const config = {
  path: "/api/studio-token",
  rateLimit: {
    windowLimit: 3,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
};
