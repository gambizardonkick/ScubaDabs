const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");
const JavaScriptObfuscator = require("javascript-obfuscator");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "10kb" }));

const CONFIG_FILE = path.join(__dirname, "admin-config.json");
const HISTORY_FILE = path.join(__dirname, "winners-history.json");

function loadJson(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  return fallback;
}
function saveJson(file, data) { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) {} }

/* ── CONFIG ── */
function defaultConfig() {
  return {
    apiKey: "gc69lpwi5txzz9k048gveum3t7pnxp5s",
    prizes: ["$600", "$200", "$150", "$50", "", "", "", "", "", "", "", "", "", "", ""],
    totalPrize: "$1,000",
    code: "TERPS",
    refUrl: "https://roulobets.com/?r=terps",
    kickChannel: "",
    raceStart: "2026-06-05",
    adminPassword: "scubadabs2026"
  };
}
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return Object.assign(defaultConfig(), JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
  } catch (e) {}
  return defaultConfig();
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

/* ── MONTHLY DATE RANGE (anchored on the admin "race start date") ── */
function ymd(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
// offset 0 = active period, -1 = previous month, etc.
function periodAt(cfg, offset) {
  const [ay, am, ad] = (cfg.raceStart || "2026-06-01").split("-").map(Number);
  const Y = ay, M0 = (am || 1) - 1, D = ad || 1;
  const now = Date.now();
  let i = 0;
  while (Date.UTC(Y, M0 + i + 1, D) <= now) i++;
  i += offset;
  const start = Date.UTC(Y, M0 + i, D);
  const resetMs = Date.UTC(Y, M0 + i + 1, D);
  return { startDay: ymd(start), endDay: ymd(resetMs - 86400000), startMs: start, resetMs, periodKey: `${ymd(start)}_${ymd(resetMs - 86400000)}` };
}
function getPeriodRange(cfg) { return periodAt(cfg, 0); }

/* ── FETCH STANDINGS FROM ROULO FOR A DATE RANGE ── */
async function fetchBoard(cfg, startDay, endDay) {
  const url = `https://api.roulobets.com/v1/external/affiliates?start_at=${startDay}&end_at=${endDay}&key=${encodeURIComponent(cfg.apiKey)}`;
  const r = await fetch(url, { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("upstream " + r.status);
  const data = await r.json();
  return (data.affiliates || [])
    .map(e => ({ name: e.username || null, wagered: Number(e.wagered_amount) || 0 }))
    .sort((a, b) => b.wagered - a.wagered);
}

/* ── BRUTE-FORCE PROTECTION ── */
const loginAttempts = new Map();
function getIp(req) { return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(); }
function isLocked(ip) {
  const e = loginAttempts.get(ip);
  if (!e) return false;
  if (e.lockedUntil && Date.now() < e.lockedUntil) return true;
  if (e.lockedUntil) { loginAttempts.delete(ip); return false; }
  return false;
}
function recordFail(ip) {
  const now = Date.now();
  const e = loginAttempts.get(ip) || { attempts: [], lockedUntil: null };
  e.attempts = e.attempts.filter(t => now - t < 600000);
  e.attempts.push(now);
  if (e.attempts.length >= 5) e.lockedUntil = now + 1800000;
  loginAttempts.set(ip, e);
}
function clearFail(ip) { loginAttempts.delete(ip); }

/* ── ADMIN MIDDLEWARE ── */
function requireAdmin(req, res, next) {
  const ip = getIp(req);
  if (isLocked(ip)) return res.status(403).json({ success: false, error: "Too many failed attempts." });
  const pw = req.body?.password || req.query?.password;
  if (!pw) return res.status(403).json({ success: false, error: "Forbidden" });
  const cfg = loadConfig();
  if (pw !== cfg.adminPassword) {
    recordFail(ip);
    const e = loginAttempts.get(ip);
    const left = Math.max(0, 5 - (e?.attempts?.length || 0));
    return res.status(403).json({ success: false, error: left > 0 ? `Wrong password. ${left} attempt${left === 1 ? "" : "s"} left.` : "Locked out for 30 minutes." });
  }
  clearFail(ip);
  next();
}

/* ── OBFUSCATOR ── */
const OBFUSCATE_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.4,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  rotateStringArray: true,
  selfDefending: false,
  shuffleStringArray: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.75,
  unicodeEscapeSequence: false
};

function obfuscateHtml(html) {
  return html.replace(/<script>([\s\S]*?)<\/script>/g, (match, code) => {
    if (!code.trim()) return match;
    try {
      const result = JavaScriptObfuscator.obfuscate(code, OBFUSCATE_OPTIONS);
      return `<script>${result.getObfuscatedCode()}</script>`;
    } catch (e) {
      return match;
    }
  });
}

/* ── PAGE CACHE ── */
let cachedIndex = null;
let cachedAdmin = null;
function buildPage(filename) {
  const raw = fs.readFileSync(path.join(__dirname, filename), "utf8");
  return obfuscateHtml(raw);
}
function getIndex() { if (!cachedIndex) cachedIndex = buildPage("index.html"); return cachedIndex; }
function getAdmin() { if (!cachedAdmin) cachedAdmin = buildPage("admin.html"); return cachedAdmin; }

/* ── SECURITY HEADERS ── */
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

/* ── LEADERBOARD CACHE (15 min) + serialized, de-duped Roulo access ── */
const BOARD_TTL = 15 * 60 * 1000;
let boardCache = null, boardCacheAt = 0, boardCacheKey = "";

// serialize every Roulo call so current + previous can never fire simultaneously
let apiBusy = false;
async function apiSlot(fn) {
  while (apiBusy) await new Promise(r => setTimeout(r, 150));
  apiBusy = true;
  try { return await fn(); } finally { apiBusy = false; }
}

// refresh current-month board (deduped; returns fresh cache without re-fetching)
let boardInflight = null;
async function refreshCurrent() {
  const cfg = loadConfig();
  const { startDay, endDay, resetMs, startMs, periodKey } = getPeriodRange(cfg);
  if (boardCache && boardCacheKey === periodKey && Date.now() - boardCacheAt < BOARD_TTL) return boardCache;
  if (boardInflight) return boardInflight;
  boardInflight = (async () => {
    try {
      const players = await apiSlot(() => fetchBoard(cfg, startDay, endDay));
      boardCache = { success: true, players, periodStart: startDay, periodEnd: endDay, resetMs, startMs };
      boardCacheAt = Date.now(); boardCacheKey = periodKey;
    } catch (e) { /* keep previous cache on failure */ }
    finally { boardInflight = null; }
    return boardCache;
  })();
  return boardInflight;
}
function emptyBoard() {
  const { startDay, endDay, resetMs, startMs } = getPeriodRange(loadConfig());
  return { success: true, players: [], periodStart: startDay, periodEnd: endDay, resetMs, startMs };
}

// ensure previous-month winners are cached (fetched once per month, deduped)
let histInflight = null;
async function ensureHistory() {
  const cfg = loadConfig();
  const prev = periodAt(cfg, -1);
  let hist = loadJson(HISTORY_FILE, []);
  if (hist.some(h => h.periodKey === prev.periodKey)) return hist;
  if (histInflight) return histInflight;
  histInflight = (async () => {
    try {
      const players = await apiSlot(() => fetchBoard(cfg, prev.startDay, prev.endDay));
      if (players.length) {
        const winners = players.slice(0, 5).map((p, i) => ({
          rank: i + 1, name: p.name || "Anonymous", wagered: p.wagered || 0, prize: (cfg.prizes || [])[i] || ""
        }));
        hist.unshift({ periodKey: prev.periodKey, periodStart: prev.startDay, periodEnd: prev.endDay, endedAt: ymd(Date.now()), totalPrize: cfg.totalPrize, winners });
        hist = hist.slice(0, 3); saveJson(HISTORY_FILE, hist);
      }
    } catch (e) { /* retry on next call */ }
    finally { histInflight = null; }
    return hist;
  })();
  return histInflight;
}

/* ── ROUTES ── */
app.get("/", (req, res) => { res.setHeader("Content-Type", "text/html"); res.send(getIndex()); });
app.get("/admin", (req, res) => { res.setHeader("Content-Type", "text/html"); res.send(getAdmin()); });

app.get("/healthz", (req, res) => res.json({ ok: true }));

// Always answers from cache instantly. Roulo is only ever called by the
// scheduler below — a page request fetches only to fill an empty cache (cold start).
app.get("/api/leaderboard", async (req, res) => {
  if (!boardCache) { try { await refreshCurrent(); } catch (e) {} }
  return res.json(boardCache || emptyBoard());
});

/* Previous month's final standings — served purely from cache; the scheduler
   keeps it populated (fetched once per month, staggered away from the live board). */
app.get("/api/history", (req, res) => {
  res.json({ history: loadJson(HISTORY_FILE, []) });
});

app.get("/api/config-public", (req, res) => {
  const cfg = loadConfig();
  const { startDay, endDay, resetMs } = getPeriodRange(cfg);
  res.json({
    prizes: cfg.prizes, totalPrize: cfg.totalPrize, code: cfg.code,
    refUrl: cfg.refUrl, kickChannel: cfg.kickChannel,
    periodStart: startDay, periodEnd: endDay, resetMs
  });
});

app.post("/api/admin/login", requireAdmin, (req, res) => res.json({ success: true }));

app.get("/api/admin/config", requireAdmin, (req, res) => {
  res.json({ success: true, config: loadConfig() });
});

app.post("/api/admin/config", requireAdmin, (req, res) => {
  const cfg = loadConfig();
  const { apiKey, prizes, totalPrize, code, refUrl, kickChannel, raceStart, adminPassword } = req.body;
  const prevStart = cfg.raceStart;
  if (apiKey?.trim()) cfg.apiKey = apiKey.trim();
  if (Array.isArray(prizes) && prizes.length >= 3) cfg.prizes = prizes.slice(0, 15);
  if (totalPrize?.trim()) cfg.totalPrize = totalPrize.trim();
  if (code?.trim()) cfg.code = code.trim();
  if (typeof refUrl === "string" && refUrl.trim()) cfg.refUrl = refUrl.trim();
  if (typeof kickChannel === "string") cfg.kickChannel = kickChannel.trim();
  if (raceStart?.trim() && /^\d{4}-\d{2}-\d{2}$/.test(raceStart.trim())) cfg.raceStart = raceStart.trim();
  if (adminPassword?.length >= 6) cfg.adminPassword = adminPassword;
  saveConfig(cfg);
  boardCache = null; boardCacheAt = 0; boardCacheKey = "";
  cachedIndex = null; cachedAdmin = null;
  // if the start date changed, the period windows shift — clear cached history so it refetches
  if (cfg.raceStart !== prevStart) saveJson(HISTORY_FILE, []);
  res.json({ success: true });
});

/* ── STATIC + CATCH-ALL ── */
const BLOCKED_FILES = /^\/?(admin-config\.json|winners-history\.json|last-board\.json|server\.js|package(-lock)?\.json|\.env.*|node_modules.*)/i;
app.use((req, res, next) => {
  if (BLOCKED_FILES.test(req.path)) return res.status(404).send("Not found");
  next();
});
app.use(express.static(__dirname, { index: false }));
app.get(/^\/assets\//, (req, res) => res.status(404).end());
app.get("*", (req, res) => { res.setHeader("Content-Type", "text/html"); res.send(getIndex()); });

// a stray error must never kill the process (a crash = Render downtime)
process.on("unhandledRejection", e => console.error("unhandledRejection:", e));
process.on("uncaughtException", e => console.error("uncaughtException:", e));

/* ── FETCH SCHEDULER ──
   The same staggered routine runs at server launch AND whenever the monthly
   period rolls over, so the new live board and the just-ended month never hit
   Roulo at the same time (15-min rate limit). */
const MIN = 60 * 1000;
let schedTimers = [];
function clearSched() { schedTimers.forEach(t => { clearTimeout(t); clearInterval(t); }); schedTimers = []; }

function startWarmup() {
  clearSched();
  // Warm-up window (first 3 hours): current @ 0,30,60… ; last month @ 15,45,75…
  refreshCurrent().catch(() => {});                                          // t=0  current
  schedTimers.push(setInterval(() => refreshCurrent().catch(() => {}), 30 * MIN));
  schedTimers.push(setTimeout(() => {
    ensureHistory().catch(() => {});                                         // t=15 last month
    schedTimers.push(setInterval(() => ensureHistory().catch(() => {}), 30 * MIN));
  }, 15 * MIN));
  // After 3 hours: steady state — current every 15 min, history every 30 min (rollover-only)
  schedTimers.push(setTimeout(() => {
    clearSched();
    schedTimers.push(setInterval(() => refreshCurrent().catch(() => {}), BOARD_TTL));
    schedTimers.push(setInterval(() => ensureHistory().catch(() => {}), 30 * MIN));
  }, 3 * 60 * MIN));
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Running on port ${PORT}`);

  startWarmup();   // launch warm-up

  // Re-run the staggered warm-up whenever the period rolls over to a new month.
  let activePeriodKey = getPeriodRange(loadConfig()).periodKey;
  setInterval(() => {
    const k = getPeriodRange(loadConfig()).periodKey;
    if (k !== activePeriodKey) {
      activePeriodKey = k;
      boardCache = null; boardCacheAt = 0; boardCacheKey = "";  // drop the ended month's cache
      startWarmup();
    }
  }, MIN);

  // free-tier keep-alive: self-ping the public URL so Render doesn't spin us down (no Roulo call)
  const SELF = process.env.RENDER_EXTERNAL_URL;
  if (SELF) setInterval(() => { fetch(`${SELF}/healthz`).catch(() => {}); }, 10 * MIN);
});
