var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var GPXZ_ORIGIN = "https://api.gpxz.io";
var NOMINATIM_OSM_ORIGIN = "https://nominatim.openstreetmap.org";
var NOMINATIM_GEOCODE_ORIGIN = "https://nominatim.geocoding.ai";
var KRON86_ORIGIN = "https://mapy.geoportal.gov.pl";
var KRON86_OPENDATA_ORIGIN = "https://opendata.geoportal.gov.pl";
var EXPOSED_HEADERS = [
  "x-ratelimit-used",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-dataset-version",
  "retry-after",
  "content-type"
].join(", ");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const proxySimple = /* @__PURE__ */ __name(async (origin, stripPrefix) => {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "content-type, accept",
            "Access-Control-Max-Age": "86400"
          }
        });
      }
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      const upstreamPath = url.pathname.slice(stripPrefix.length);
      const upstreamUrl = `${origin}${upstreamPath}${url.search}`;
      const isNominatimOrigin = origin.includes("nominatim");
      const requestOrigin = `${url.protocol}//${url.host}`;
      const upstream = await fetch(upstreamUrl, {
        method: "GET",
        headers: {
          "Accept": request.headers.get("Accept") || "application/json",
          ...request.headers.get("Accept-Language") ? { "Accept-Language": request.headers.get("Accept-Language") } : {},
          ...isNominatimOrigin ? {
            // Identify the app to align with Nominatim usage policy and reduce 403 blocks.
            "User-Agent": "mapng/1.0 (+https://mapng.dev; contact: nikkiluzader@gmail.com)",
            "Referer": requestOrigin
          } : {}
        }
      });
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      });
    }, "proxySimple");
    if (url.pathname.startsWith("/api/nominatim-osm/")) {
      return proxySimple(NOMINATIM_OSM_ORIGIN, "/api/nominatim-osm");
    }
    if (url.pathname.startsWith("/api/nominatim-geocode/")) {
      return proxySimple(NOMINATIM_GEOCODE_ORIGIN, "/api/nominatim-geocode");
    }
    if (url.pathname.startsWith("/api/kron86/")) {
      return proxySimple(KRON86_ORIGIN, "/api/kron86");
    }
    if (url.pathname.startsWith("/api/kron86-opendata/")) {
      return proxySimple(KRON86_OPENDATA_ORIGIN, "/api/kron86-opendata");
    }
    if (!url.pathname.startsWith("/api/gpxz/")) {
      return env.ASSETS.fetch(request);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "x-api-key, content-type",
          "Access-Control-Max-Age": "86400"
        }
      });
    }
    const gpxzPath = url.pathname.slice("/api/gpxz".length);
    const gpxzUrl = `${GPXZ_ORIGIN}${gpxzPath}${url.search}`;
    const forwardHeaders = new Headers();
    const apiKey = request.headers.get("x-api-key");
    if (apiKey) forwardHeaders.set("x-api-key", apiKey);
    forwardHeaders.set("Accept", request.headers.get("Accept") || "*/*");
    try {
      const upstream = await fetch(gpxzUrl, {
        method: request.method,
        headers: forwardHeaders
      });
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "GPXZ proxy error", message: e.message }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
