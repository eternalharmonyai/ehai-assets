/**
 * ═══════════════════════════════════════════════════════════════
 * REUSABLE STATS TRACKER WORKER (Cloudflare Workers)
 * ═══════════════════════════════════════════════════════════════
 *
 * WHAT THIS DOES:
 *   - Tracks pageviews, video plays, contact submits via POST /track
 *   - Provides a password-protected stats dashboard at GET /dashboard
 *   - JSON stats API at GET /api/stats (same auth as dashboard)
 *   - Daily cron that snapshots stats for historical comparison
 *   - Contact form submission via POST /api/contact
 *
 * WHAT TO CUSTOMIZE (search for 🔧 PLACEHOLDER):
 *   1. ALLOWED_ORIGIN env vars      — your website URL(s)
 *   2. SESSION_SECRET               — random string for cookie signing
 *   3. DASHBOARD_PASSWORD           — password to access the dashboard
 *   4. BRAND / title references     — page titles, headers
 *   5. Contact email (optional)     — where to forward contact form messages
 *
 * DEPLOYMENT:
 *   1. Create a D1 database:  wrangler d1 create your-stats-db
 *   2. Run schema.sql:        wrangler d1 execute your-stats-db --file=src/schema.sql
 *   3. Update wrangler.toml with your D1 ID, KV ID, and secrets
 *   4. Deploy:                wrangler deploy
 *
 * ORIGIN: Extracted from stats.jeantobin.com (Eternal Harmony, 2026)
 * LICENSE: Free to reuse — built by Eternal Harmony AI
 * ═══════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION — 🔧 PLACEHOLDER: Customize these
// ═══════════════════════════════════════════════════════════════

// 🔧 PLACEHOLDER: Set your dashboard password (change before deploy!)
const DASHBOARD_PASSWORD = '🔧 change-me-please';

// 🔧 PLACEHOLDER: Your brand name (appears in dashboard title)
const BRAND_NAME = '🔧 Your Site';

// 🔧 PLACEHOLDER: Contact form forwarding (requires Cloudflare Email Routing)
// Set to null to disable email forwarding. Otherwise, configure send_email in wrangler.toml.
const CONTACT_EMAIL_FROM = null; // e.g. 'hello@yoursite.com'
const CONTACT_EMAIL_TO   = null; // e.g. 'you@gmail.com'

// Session cookie settings
const SESSION_COOKIE = 'stats_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ═══════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/** Check if the request origin is allowed */
function isAllowed(env, origin, referer) {
  const o = origin || '';
  const r = referer || '';
  const exact = [env.ALLOWED_ORIGIN, env.ALLOWED_ORIGIN_WWW, env.ALLOWED_ORIGIN_DEV].filter(Boolean);
  if (exact.includes(o) || exact.some(e => r.startsWith(e + '/'))) return true;
  // 🔧 PLACEHOLDER: Add pages.dev fallback for preview deployments
  // if (o.endsWith('.your-project.pages.dev') || r.includes('.your-project.pages.dev/')) return true;
  return false;
}

/** Generate CORS response headers */
function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = isAllowed(env, origin);
  return {
    'Access-Control-Allow-Origin': allowed ? (origin || '*') : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400'
  };
}

function jsonH() {
  return { 'Content-Type': 'application/json' };
}

function htmlHeaders() {
  return { 'Content-Type': 'text/html; charset=utf-8' };
}

function jsonCors(body, req, env, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { ...jsonH(), ...corsHeaders(req, env) } });
}

/** SHA-256 hash (Web Crypto) */
async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 signing for session cookies */
async function hmacSign(payload, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function b64url(str) { return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

function constantTimeEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Classify user agent into device type */
function classifyDevice(ua) {
  if (!ua) return 'unknown';
  if (/Tablet|iPad/i.test(ua)) return 'tablet';
  if (/Mobile|iPhone|Android(?!.*Tablet)/i.test(ua)) return 'mobile';
  return 'desktop';
}

/** Safe field cleaning */
function cleanField(val, maxLen) {
  return String(val || '').replace(/\s+/g, ' ').trim().slice(0, maxLen || 256);
}
function cleanMultiline(val, maxLen) {
  return String(val || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxLen || 4000);
}

/** Percentage change with zero-guard */
function pctChange(curr, prev) {
  curr = +curr || 0; prev = +prev || 0;
  if (prev === 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 100);
}

// ═══════════════════════════════════════════════════════════════
// EVENT TRACKING — POST /track
// ═══════════════════════════════════════════════════════════════
async function handleTrack(request, env) {
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';
  if (!isAllowed(env, origin, referer)) {
    return jsonCors({ ok: false, err: 'origin' }, request, env, 403);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonCors({ ok: false, err: 'json' }, request, env, 400); }

  const type = String(body.type || '').slice(0, 32);
  if (!['pageview', 'video_play', 'video_progress', 'video_complete', 'contact_submit'].includes(type)) {
    return jsonCors({ ok: false, err: 'type' }, request, env, 400);
  }

  // Build anonymous daily-rotating session hash
  const cf = request.cf || {};
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';
  const today = new Date().toISOString().slice(0, 10);
  const sessionHash = await sha256(`${ip}|${ua}|${today}|${env.SESSION_SECRET || ''}`).then(h => h.slice(0, 16));

  // Sanitize referrer
  let referrerHost = '';
  if (body.referrer) {
    try { referrerHost = new URL(body.referrer).hostname.replace(/^www\./, '').slice(0, 64); }
    catch { /* ignore */ }
  }

  // Determine domain
  let domain = origin.replace(/^https?:\/\//, '');
  if (!domain && referer) { try { domain = new URL(referer).hostname; } catch {} }

  await env.DB.prepare(
    `INSERT INTO events (ts, type, page, video_id, video_pos, referrer_host, country, region, device, session_hash, domain)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    Date.now(), type,
    String(body.page || '').slice(0, 128) || null,
    String(body.video_id || '').slice(0, 96) || null,
    Number.isFinite(+body.video_pos) ? Math.floor(+body.video_pos) : null,
    referrerHost || null,
    (cf.country || '').toString().slice(0, 2) || null,
    (cf.region || cf.regionCode || '').toString().slice(0, 8) || null,
    classifyDevice(ua),
    sessionHash,
    domain ? domain.slice(0, 64) : null
  ).run();

  return jsonCors({ ok: true }, request, env, 200);
}

// ═══════════════════════════════════════════════════════════════
// SESSION AUTH — password-gated dashboard access
// ═══════════════════════════════════════════════════════════════

async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ ok: false }), { status: 400, headers: jsonH() }); }

  if (body.password !== DASHBOARD_PASSWORD) {
    return new Response(JSON.stringify({ ok: false }), { status: 401, headers: jsonH() });
  }

  const token = await mintSession(env);
  const headers = new Headers(jsonH());
  headers.append('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function handleLogout() {
  const headers = new Headers(jsonH());
  headers.append('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function mintSession(env) {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_TTL_MS });
  const sig = await hmacSign(payload, env.SESSION_SECRET || 'dev-secret');
  return b64url(payload) + '.' + sig;
}

async function verifySession(token, env) {
  try {
    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig) return false;
    const payload = b64urlDecode(payloadB64);
    const expectedSig = await hmacSign(payload, env.SESSION_SECRET || 'dev-secret');
    if (!constantTimeEq(sig, expectedSig)) return false;
    const data = JSON.parse(payload);
    return data.exp > Date.now();
  } catch { return false; }
}

async function isAuthed(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!m) return false;
  return await verifySession(m[1], env);
}

// ═══════════════════════════════════════════════════════════════
// STATS API — GET /api/stats (requires session)
// ═══════════════════════════════════════════════════════════════

async function handleApiStats(request, env) {
  if (!await isAuthed(request, env)) {
    return new Response(JSON.stringify({ ok: false, err: 'auth' }), { status: 401, headers: jsonH() });
  }
  const url = new URL(request.url);
  const range = url.searchParams.get('range') || '30d';
  const scope = url.searchParams.get('scope') || 'all';
  const data = await buildStatsPayload(env, { range, scope });
  return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: jsonH() });
}

/** Parse range params into timestamps */
function parseRange({ range }) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const map = { '7d': 7, '30d': 30, '90d': 90 };
  if (range === 'all') {
    return { fromTs: 0, toTs: now, prevFrom: 0, prevTo: 0, lengthDays: null };
  }
  const days = map[range] || 30;
  return {
    fromTs: now - days * day, toTs: now,
    prevFrom: now - 2 * days * day, prevTo: now - days * day,
    lengthDays: days
  };
}

/** Main stats payload builder */
async function buildStatsPayload(env, opts) {
  const now = Date.now();
  const { fromTs, toTs, prevFrom, prevTo, lengthDays } = parseRange(opts || {});

  // 🔧 PLACEHOLDER: Customize your domain filter
  const sFilter = "domain = '🔧 yoursite.com' OR domain = 'www.🔧 yoursite.com' OR domain IS NULL";

  // Lifetime totals
  const lifetime = await env.DB.prepare(`
    SELECT
      COUNT(DISTINCT session_hash) AS visitors,
      SUM(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
      SUM(CASE WHEN type = 'video_play' THEN 1 ELSE 0 END) AS video_plays,
      SUM(CASE WHEN type = 'video_complete' THEN 1 ELSE 0 END) AS video_completes,
      COALESCE(SUM(CASE WHEN type = 'video_progress' THEN video_pos ELSE 0 END), 0) AS total_watch_seconds,
      SUM(CASE WHEN type = 'contact_submit' THEN 1 ELSE 0 END) AS contact_submits
    FROM events WHERE (${sFilter})
  `).first();

  // Selected period + previous period (for trend comparison)
  const period = await rangeStats(env, fromTs, toTs, sFilter);
  const prev = (prevFrom && prevTo && prevFrom > 0) ? await rangeStats(env, prevFrom, prevTo, sFilter) : null;

  // Top pages
  const topPages = (await env.DB.prepare(`
    SELECT page, COUNT(*) AS hits FROM events
    WHERE type = 'pageview' AND ts > ? AND ts <= ? AND page IS NOT NULL AND (${sFilter})
    GROUP BY page ORDER BY hits DESC LIMIT 10
  `).bind(fromTs, toTs).all()).results;

  // Top videos
  const topVideos = (await env.DB.prepare(`
    SELECT video_id,
      SUM(CASE WHEN type='video_play' THEN 1 ELSE 0 END) AS plays,
      SUM(CASE WHEN type='video_complete' THEN 1 ELSE 0 END) AS completes,
      SUM(CASE WHEN type='video_progress' THEN video_pos ELSE 0 END) AS watch_seconds
    FROM events WHERE video_id IS NOT NULL AND (${sFilter})
    GROUP BY video_id ORDER BY plays DESC LIMIT 12
  `).all()).results;

  // Top referrers
  const topReferrers = (await env.DB.prepare(`
    SELECT referrer_host, COUNT(*) AS hits FROM events
    WHERE ts > ? AND ts <= ? AND referrer_host IS NOT NULL AND referrer_host != '' AND (${sFilter})
    GROUP BY referrer_host ORDER BY hits DESC LIMIT 8
  `).bind(fromTs, toTs).all()).results;

  // Geo: top regions
  const topRegions = (await env.DB.prepare(`
    SELECT region, country, COUNT(DISTINCT session_hash) AS visitors FROM events
    WHERE ts > ? AND ts <= ? AND region IS NOT NULL AND region != '' AND (${sFilter})
    GROUP BY region, country ORDER BY visitors DESC LIMIT 10
  `).bind(fromTs, toTs).all()).results;

  // Device split
  const devices = (await env.DB.prepare(`
    SELECT device, COUNT(DISTINCT session_hash) AS visitors FROM events
    WHERE ts > ? AND ts <= ? AND device IS NOT NULL AND (${sFilter})
    GROUP BY device
  `).bind(fromTs, toTs).all()).results;

  // Daily series (for charts)
  const series = (await env.DB.prepare(`
    SELECT
      strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS day,
      COUNT(DISTINCT session_hash) AS visitors,
      SUM(CASE WHEN type='pageview' THEN 1 ELSE 0 END) AS pageviews,
      SUM(CASE WHEN type='video_play' THEN 1 ELSE 0 END) AS plays
    FROM events WHERE ts > ? AND ts <= ? AND (${sFilter})
    GROUP BY day ORDER BY day ASC
  `).bind(fromTs, toTs).all()).results;

  // Top video this period (for insights)
  const topVideoThisWeek = (await env.DB.prepare(`
    SELECT video_id, COUNT(*) AS plays FROM events
    WHERE type='video_play' AND ts > ? AND ts <= ? AND video_id IS NOT NULL AND (${sFilter})
    GROUP BY video_id ORDER BY plays DESC LIMIT 1
  `).bind(fromTs, toTs).first());

  const insights = computeLiveInsights({ period, prev, lifetime, topVideoThisWeek, generated_at: now });

  return {
    generated_at: now,
    range: opts.range || '30d',
    range_length_days: lengthDays,
    lifetime, period,
    trends: prev ? {
      visitors_pct:  pctChange(period.visitors, prev.visitors),
      pageviews_pct: pctChange(period.pageviews, prev.pageviews),
      plays_pct:     pctChange(period.video_plays, prev.video_plays)
    } : { visitors_pct: null, pageviews_pct: null, plays_pct: null },
    topPages, topVideos, topReferrers, topRegions, devices, series, insights
  };
}

/** Run a range-bounded stats aggregation */
async function rangeStats(env, fromTs, toTs, sFilter) {
  const r = await env.DB.prepare(`
    SELECT
      COUNT(DISTINCT session_hash) AS visitors,
      SUM(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
      SUM(CASE WHEN type = 'video_play' THEN 1 ELSE 0 END) AS video_plays,
      SUM(CASE WHEN type = 'video_complete' THEN 1 ELSE 0 END) AS video_completes,
      COALESCE(SUM(CASE WHEN type = 'video_progress' THEN video_pos ELSE 0 END), 0) AS total_watch_seconds,
      SUM(CASE WHEN type = 'contact_submit' THEN 1 ELSE 0 END) AS contact_submits
    FROM events WHERE ts > ? AND ts <= ? AND (${sFilter})
  `).bind(fromTs, toTs).first();
  return r || { visitors: 0, pageviews: 0, video_plays: 0, video_completes: 0, total_watch_seconds: 0, contact_submits: 0 };
}

// ═══════════════════════════════════════════════════════════════
// SMART INSIGHTS — Human-readable observations from the data
// ═══════════════════════════════════════════════════════════════
function computeLiveInsights({ period, prev, lifetime, topVideoThisWeek, generated_at }) {
  const insights = [];
  const ts = generated_at || Date.now();

  // 🔧 PLACEHOLDER: Customize insight thresholds and messaging for your audience

  // Visitor trend
  if (prev) {
    const visitorsTrend = pctChange(period.visitors, prev.visitors);
    if (Math.abs(visitorsTrend) >= 15 && period.visitors >= 5) {
      insights.push({
        kind: 'trend', emoji: visitorsTrend > 0 ? '📈' : '📉',
        headline: `Visitors ${visitorsTrend > 0 ? 'up' : 'down'} ${Math.abs(visitorsTrend)}% this period`,
        detail: `${period.visitors} unique visitors, vs ${prev.visitors} the previous period.`,
        metric_key: 'visitors', delta_pct: visitorsTrend, ts
      });
    }

    const playsTrend = pctChange(period.video_plays, prev.video_plays);
    if (Math.abs(playsTrend) >= 20 && period.video_plays >= 3) {
      insights.push({
        kind: 'trend', emoji: playsTrend > 0 ? '🎬' : '⏸️',
        headline: `Video plays ${playsTrend > 0 ? 'rising' : 'cooling'} — ${playsTrend > 0 ? '+' : ''}${playsTrend}%`,
        detail: `${period.video_plays} video plays vs ${prev.video_plays} the previous period.`,
        metric_key: 'video_plays', delta_pct: playsTrend, ts
      });
    }
  }

  // Milestones
  for (const m of [100, 250, 500, 1000, 2500, 5000, 10000]) {
    if (lifetime.visitors >= m && lifetime.visitors < m + 25) {
      insights.push({
        kind: 'milestone', emoji: '🎉',
        headline: `${m.toLocaleString()} lifetime visitors reached!`,
        detail: `Your site has now been visited by ${lifetime.visitors.toLocaleString()} unique visitors.`,
        metric_key: 'visitors', ts
      });
      break;
    }
  }

  // Top video highlight
  if (topVideoThisWeek && topVideoThisWeek.video_id && topVideoThisWeek.plays >= 2) {
    insights.push({
      kind: 'highlight', emoji: '🔥',
      headline: `Most-watched: "${topVideoThisWeek.video_id}"`,
      detail: `${topVideoThisWeek.plays} plays this period — people are finding this one.`,
      metric_key: 'video_plays', ts
    });
  }

  // Engagement quality
  if (period.visitors > 0 && period.video_plays > 0) {
    const ratio = (period.video_plays / period.visitors).toFixed(1);
    if (+ratio >= 1.5) {
      insights.push({
        kind: 'trend', emoji: '⭐',
        headline: `High engagement: ${ratio} video plays per visitor`,
        detail: `Visitors are watching multiple videos — strong content resonance.`,
        metric_key: 'video_plays', ts
      });
    }
  }

  return insights.length > 0 ? insights : [{
    kind: 'trend', emoji: '👋',
    headline: 'Dashboard is live — waiting for data',
    detail: 'Once visitors start arriving, insights will appear here automatically.',
    metric_key: 'visitors', ts
  }];
}

// ═══════════════════════════════════════════════════════════════
// CONTACT FORM — POST /api/contact
// ═══════════════════════════════════════════════════════════════
async function handleContact(request, env) {
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';
  if (!isAllowed(env, origin, referer)) {
    return jsonCors({ ok: false, err: 'origin' }, request, env, 403);
  }

  let fields;
  try {
    const contentType = request.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      const body = await request.json();
      fields = { get: key => body[key] };
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      fields = new URLSearchParams(await request.text());
    } else {
      fields = await request.formData();
    }
  } catch { return jsonCors({ ok: false, err: 'body' }, request, env, 400); }

  // Honeypot check
  if (cleanField(fields.get('website'), 128)) return jsonCors({ ok: true }, request, env, 200);

  const name = cleanField(fields.get('name'), 120);
  const email = cleanField(fields.get('email'), 160).toLowerCase();
  const message = cleanMultiline(fields.get('message'), 4000);
  const page = cleanField(fields.get('page'), 128) || null;

  if (!name || !email || !message) return jsonCors({ ok: false, err: 'required' }, request, env, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonCors({ ok: false, err: 'email' }, request, env, 400);

  const ua = request.headers.get('User-Agent') || '';
  const cf = request.cf || {};

  let referrerHost = '';
  const refField = cleanField(fields.get('referrer'), 512) || referer;
  if (refField) {
    try { referrerHost = new URL(refField).hostname.replace(/^www\./, '').slice(0, 64); }
    catch { /* ignore */ }
  }

  let domain = origin.replace(/^https?:\/\//, '');
  if (!domain && referer) { try { domain = new URL(referer).hostname; } catch {} }

  await env.DB.prepare(`
    INSERT INTO contact_messages (ts, name, email, phone, message, page, referrer_host, country, region, device, domain, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
  `).bind(
    Date.now(), name, email, cleanField(fields.get('phone'), 80), message, page,
    referrerHost || null,
    (cf.country || '').toString().slice(0, 2) || null,
    (cf.region || cf.regionCode || '').toString().slice(0, 8) || null,
    classifyDevice(ua),
    domain ? domain.slice(0, 64) : null
  ).run();

  // Optional: forward via email
  if (CONTACT_EMAIL_FROM && CONTACT_EMAIL_TO) {
    try {
      const { EmailMessage } = await import('cloudflare:email');
      const emailMsg = new EmailMessage(
        CONTACT_EMAIL_FROM, CONTACT_EMAIL_TO,
        `New message from ${name} via ${domain || 'your site'}`,
        `Name: ${name}\nEmail: ${email}\n\n${message}`
      );
      await env.SEB.send(emailMsg);
    } catch { /* email is optional */ }
  }

  return jsonCors({ ok: true }, request, env, 200);
}

// ═══════════════════════════════════════════════════════════════
// DAILY CRON — Snapshot stats for historical comparison
// ═══════════════════════════════════════════════════════════════
async function runDailyAggregation(env) {
  const sFilter = "domain = '🔧 yoursite.com' OR domain = 'www.🔧 yoursite.com' OR domain IS NULL";
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const fromTs = now - day;

  const stats = await rangeStats(env, fromTs, now, sFilter);
  const today = new Date().toISOString().slice(0, 10);

  await env.DB.prepare(`
    INSERT INTO daily_snapshots (date, visitors, pageviews, video_plays, video_completes, total_watch_seconds, contact_submits, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      visitors = excluded.visitors, pageviews = excluded.pageviews,
      video_plays = excluded.video_plays, video_completes = excluded.video_completes,
      total_watch_seconds = excluded.total_watch_seconds, contact_submits = excluded.contact_submits
  `).bind(
    today, stats.visitors, stats.pageviews, stats.video_plays,
    stats.video_completes, stats.total_watch_seconds, stats.contact_submits, now
  ).run();
}

// ═══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      // Public endpoints
      if (request.method === 'POST' && path === '/track')        return handleTrack(request, env);
      if (request.method === 'POST' && path === '/api/contact')  return handleContact(request, env);

      // Auth endpoints
      if (request.method === 'POST' && path === '/login')        return handleLogin(request, env);
      if (request.method === 'POST' && path === '/logout')       return handleLogout();

      // Dashboard (requires auth) — serves inline HTML + JS
      if (request.method === 'GET'  && path === '/dashboard')    return handleDashboard(request, env);
      if (request.method === 'GET'  && path === '/api/stats')    return handleApiStats(request, env);

      // Login page (served at root)
      if (request.method === 'GET'  && path === '/')             return handleLoginPage(env);

      // CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error('Worker error:', err);
      return new Response('Internal error', { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyAggregation(env));
  }
};

// ═══════════════════════════════════════════════════════════════
// LOGIN PAGE — Minimal password gate
// ═══════════════════════════════════════════════════════════════
function handleLoginPage(env) {
  const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🔧 Stats — ${BRAND_NAME}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0E1B1A;color:#ECE7DC}
  .card{background:#142625;border:1px solid #1F3431;border-radius:12px;padding:32px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,.3)}
  h1{font-size:20px;color:#6FE0D0;margin-bottom:6px}
  p{font-size:13px;color:#8E9C99;margin-bottom:20px}
  input{width:100%;padding:12px;font-size:15px;border:1px solid #1F3431;border-radius:8px;background:#0A1716;color:#ECE7DC;margin-bottom:12px}
  input:focus{outline:none;border-color:#6FE0D0}
  button{width:100%;padding:12px;font-size:14px;font-weight:600;background:#6FE0D0;color:#0E1B1A;border:none;border-radius:8px;cursor:pointer}
  button:hover{opacity:.9}
  .err{color:#ff9b9b;font-size:12px;margin-top:8px;text-align:center}
</style>
</head>
<body>
<div class="card">
  <h1>🔧 ${BRAND_NAME} Stats</h1>
  <p>Enter the dashboard password to continue.</p>
  <form id="f"><input type="password" id="pw" placeholder="Password" autofocus required><button type="submit">Sign In</button></form>
  <p class="err" id="err"></p>
</div>
<script>
document.getElementById('f').addEventListener('submit',async function(e){e.preventDefault();
  var r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
  if(r.ok){location.href='/dashboard'}else{document.getElementById('err').textContent='Wrong password.'}
})
</script>
</body>
</html>`;
  return new Response(html, { status: 200, headers: htmlHeaders() });
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD PAGE — Serves the stats-dashboard.html shell
// ═══════════════════════════════════════════════════════════════
async function handleDashboard(request, env) {
  if (!await isAuthed(request, env)) {
    return new Response('Unauthorized. <a href="/">Sign in</a>', { status: 401, headers: htmlHeaders() });
  }
  // 🔧 PLACEHOLDER: Replace with your actual dashboard HTML.
  // For now, returns a minimal page that loads the shell from the frontend.
  // In production, you'd inline the stats-dashboard.html shell here.
  const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Stats Dashboard — ${BRAND_NAME}</title>
<style>
  body { min-height:100vh; display:grid; place-items:center; background:#0E1B1A; color:#ECE7DC; font-family:sans-serif; }
  a { color:#6FE0D0; }
</style>
</head>
<body>
  <div style="text-align:center">
    <h1>🔧 ${BRAND_NAME} Stats Dashboard</h1>
    <p>🔧 Replace this page with your <code>stats-dashboard.html</code> shell content.</p>
    <p>The dashboard shell calls <code>/api/stats</code> for data.</p>
    <a href="/logout">Sign Out</a>
  </div>
</body>
</html>`;
  return new Response(html, { status: 200, headers: htmlHeaders() });
}
