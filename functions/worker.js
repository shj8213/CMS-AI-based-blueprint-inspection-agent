import { onRequestGet as getConfig } from "./api/config.js";
import { onRequestPost as getStudioToken } from "./api/studio-tokens.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/config" && request.method === "GET") return getConfig({ env });
    if (url.pathname === "/api/studio-token" && request.method === "POST") {
      return getStudioToken({ request, env });
    }
    if (url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
