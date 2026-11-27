export default {
  async fetch(req, env, ctx) {
    // 1. Define your allowed origins here
    const allowedOrigins = [
      "https://darkify.sellhub.cx"
    ];

    // 2. Get the Origin header from the incoming request
    const requestOrigin = req.headers.get("Origin");

    // 3. Set up the base CORS headers (without the Origin yet)
    const corsHeaders = {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // 4. If the request's origin matches one in your list, allow it
    if (allowedOrigins.includes(requestOrigin)) {
      corsHeaders["Access-Control-Allow-Origin"] = requestOrigin;
    }

    // Handle OPTIONS (Preflight) requests
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ── /ingest: GitHub Actions posts the myvouch.es HTML here (myvouch.es rate-limits
    //    Cloudflare Worker IPs with HTTP 429, so the Worker can't fetch it itself) ──
    const reqUrl = new URL(req.url);
    if (reqUrl.pathname === "/ingest") {
      return handleIngest(req, env);
    }

    // ── /stats: combined live sales + customer counts across both stores ──
    if (reqUrl.pathname === "/stats") {
      return handleStats(req, env, ctx, corsHeaders);
    }

    const stored = await loadVouches(env);
    if (stored) {
      return new Response(JSON.stringify(stored.vouches, null, 2), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
          "X-Vouches-Updated": stored.updatedAt
        }
      });
    }

    // Nothing stored yet: fall back to fetching live (usually 429 from Worker IPs).

    const url = "https://myvouch.es/api/darkify/vouches/embed";

    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: "Fetch failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const { vouches } = parseVouches(await res.text());

    return new Response(JSON.stringify(vouches, null, 2), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300"
      }
    });
  }
};

// ── Combined live stats (Zenyth + Darkify) ──
// Requires two Worker secrets set in the Cloudflare dashboard (Settings -> Variables and Secrets):
//   ZENYTH_API_KEY   -- Sellhub API key from the Zenyth store dashboard
//   DARKIFY_API_KEY  -- Sellhub API key from the Darkify store dashboard
const SELLHUB_API_BASE = "https://dash.sellhub.cx/api/sellhub";
const STATS_CACHE_SECONDS = 600; // 10 minutes

async function fetchStoreTotals(apiKey) {
  const headers = { "Authorization": apiKey };
  const [storeRes, customersRes] = await Promise.all([
    fetch(SELLHUB_API_BASE + "/store", { headers }),
    fetch(SELLHUB_API_BASE + "/customers", { headers }),
  ]);

  const storeJson = storeRes.ok ? await storeRes.json() : null;
  const customersJson = customersRes.ok ? await customersRes.json() : null;

  const totalSales = storeJson?.data?.store?.totalSales ?? 0;
  const customers = customersJson?.data?.customers;
  const totalCustomers = Array.isArray(customers) ? customers.length : 0;

  return { totalSales, totalCustomers };
}

// Sellhub's own native review system (GET /reviews) is separate from the Discord vouches on
// myvouch.es and came back empty for both stores — this store's real social proof lives entirely
// on myvouch.es. So the average rating is computed from that same vouches feed instead (every
// vouch already carries a `stars` value, scraped with the same regex used for /vouches above).
// Since myvouch.es/darkify is the very same project just renamed from "zenyth", this single feed
// already represents the combined old+new store history — no separate Zenyth fetch needed here.
async function fetchVouchRatingStats(env) {
  const stored = await loadVouches(env);
  if (stored) return { ratingSum: stored.ratingSum, ratingCount: stored.ratingCount };

  const res = await fetch("https://myvouch.es/api/darkify/vouches/embed", {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  if (!res.ok) return { ratingSum: 0, ratingCount: 0 };

  const { ratingSum, ratingCount } = parseVouches(await res.text());
  return { ratingSum, ratingCount };
}

async function handleStats(req, env, ctx, corsHeaders) {
  const cache = caches.default;
  // This is a lookup key for Cloudflare's edge Cache API only — it is never actually
  // fetched over the network. Built from this Worker's own URL (stripped of query params)
  // so every visitor's request maps to the same cached entry.
  const cacheUrl = new URL(req.url);
  cacheUrl.search = "";
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.text();
    return new Response(body, {
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=" + STATS_CACHE_SECONDS }
    });
  }

  const keys = [env.ZENYTH_API_KEY, env.DARKIFY_API_KEY];
  const emptyTotals = { totalSales: 0, totalCustomers: 0 };
  const [storeResults, ratingStats] = await Promise.all([
    Promise.all(
      keys.map(key =>
        key
          ? fetchStoreTotals(key).catch(() => emptyTotals)
          : Promise.resolve(emptyTotals)
      )
    ),
    fetchVouchRatingStats(env).catch(() => ({ ratingSum: 0, ratingCount: 0 })),
  ]);

  const totals = storeResults.reduce(
    (acc, r) => ({
      totalSales: acc.totalSales + r.totalSales,
      totalCustomers: acc.totalCustomers + r.totalCustomers,
    }),
    { totalSales: 0, totalCustomers: 0 }
  );

  const combined = {
    totalSales: totals.totalSales,
    totalCustomers: totals.totalCustomers,
    // Computed from the myvouch.es vouches feed (see fetchVouchRatingStats) since Sellhub's
    // native review system has no data for either store.
    averageRating: ratingStats.ratingCount > 0 ? ratingStats.ratingSum / ratingStats.ratingCount : 0,
  };

  const payload = JSON.stringify(combined);

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(payload, {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=" + STATS_CACHE_SECONDS }
      })
    )
  );

  return new Response(payload, {
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=" + STATS_CACHE_SECONDS }
  });
}

// ── Vouch parsing (shared by /ingest and the live-fetch fallback) ──
// Returns the 5-star vouches for display plus rating totals over every rated vouch.
function parseVouches(html) {
  const slides = html.split('<div class="swiper-slide">').slice(1);
  let ratingSum = 0;
  let ratingCount = 0;

  const vouches = slides.map(slide => {
    const stars = (slide.match(/fa-solid fa-star(?![^"]*opacity-30)/g) || []).length;
    if (stars > 0) {
      ratingSum += stars;
      ratingCount += 1;
    }

    // ⛔ Ignore anything below 5 stars
    if (stars < 5) return null;

    const username = match(slide, /id\.rappytv\.com\/\d+">([^<]+)</);
    const avatar = match(slide, /<img[^>]+src="([^"]+)"/);
    // Height class is whatever the myvouch.es embed theme currently uses (was h-[100px], now h-[64px]) —
    // match any pixel value so a future theme tweak doesn't silently break this again.
    const message = match(slide, /<div class="h-\[\d+px\][^>]*overflow-y-auto[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
    // The current myvouch.es/darkify theme no longer renders a per-vouch date anywhere in the HTML
    // (the old ".text-right" timestamp div is gone) — this will stay null until that comes back.
    const date = match(slide, /<div class="text-right">\s*([^<]+)\s*</);
    // Proof links are rendered as absolute URLs (https://myvouch.es/storage/discord-proofs/...),
    // not relative ones — match both forms so this keeps working if that ever changes back.
    const proof = match(slide, /href="(https?:\/\/myvouch\.es\/storage\/discord-proofs\/[^"]+|\/storage\/discord-proofs\/[^"]+)"/);

    return {
      username: username || "Unknown",
      avatar: avatar ? abs(avatar) : null,
      message: clean(message),
      date: date || null,
      proof: proof ? abs(proof) : null,
      stars
    };
  }).filter(Boolean); // Remove nulls

  return { vouches, ratingSum, ratingCount, slideCount: slides.length };
}

// ── KV storage: the last good copy, written by /ingest ──
const VOUCHES_KEY = "vouches";

async function loadVouches(env) {
  if (!env.VOUCHES) return null;
  return env.VOUCHES.get(VOUCHES_KEY, { type: "json", cacheTtl: 300 });
}

// POST /ingest  (Authorization: Bearer <INGEST_TOKEN>, body = raw myvouch.es embed HTML)
async function handleIngest(req, env) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!env.INGEST_TOKEN || !env.VOUCHES) return new Response("Ingest not configured", { status: 500 });

  const auth = req.headers.get("Authorization") || "";
  const enc = new TextEncoder();
  const a = enc.encode(auth), b = enc.encode("Bearer " + env.INGEST_TOKEN);
  if (a.length !== b.length || !crypto.subtle.timingSafeEqual(a, b)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const parsed = parseVouches(await req.text());
  // Refuse to overwrite a good copy with a broken/empty page (theme change, error page, ...).
  if (parsed.slideCount === 0 || parsed.vouches.length === 0) {
    return new Response(JSON.stringify({ error: "no vouches found in body", slides: parsed.slideCount }),
      { status: 422, headers: { "Content-Type": "application/json" } });
  }

  const record = {
    updatedAt: new Date().toISOString(),
    vouches: parsed.vouches,
    ratingSum: parsed.ratingSum,
    ratingCount: parsed.ratingCount
  };
  await env.VOUCHES.put(VOUCHES_KEY, JSON.stringify(record));
  return new Response(JSON.stringify({
    ok: true, slides: parsed.slideCount, vouches: parsed.vouches.length,
    averageRating: parsed.ratingCount ? parsed.ratingSum / parsed.ratingCount : 0
  }), { headers: { "Content-Type": "application/json" } });
}

function match(str, regex) {
  const m = str.match(regex);
  return m ? m[1].trim() : null;
}

function clean(str) {
  if (!str) return "";
  // Vouch text was originally written for the old "Zenyth" branding — rebrand to Darkify.
  return str.replace(/\s+/g, " ").replace(/zenyth/gi, "Darkify").trim();
}

function abs(path) {
  if (path.startsWith("http")) return path;
  return "https://myvouch.es" + path;
}
