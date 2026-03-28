// ═══════════════════════════════════════════════════════════════
// db.js — Database Layer using Backblaze B2
// Drop-in replacement for firebase.js
// Same function signatures, same return values
// Uses in-memory cache for fast reads, writes to B2 asynchronously
// ═══════════════════════════════════════════════════════════════

const storage = require('./storage');

// ── IN-MEMORY CACHE ───────────────────────────────────────────
const CACHE = {};
const CACHE_TTL = {
  'instruments':    60 * 60 * 1000,  // 1 hour
  'snapshot':       5  * 60 * 1000,  // 5 min
  'ai_analysis':    10 * 60 * 1000,  // 10 min
  'news':           5  * 60 * 1000,  // 5 min
  'preferences':    60 * 60 * 1000,  // 1 hour
  'calibration':    60 * 60 * 1000,  // 1 hour
  'universe':       60 * 60 * 1000,  // 1 hour
};

function cacheGet(key) {
  const entry = CACHE[key];
  if (!entry) return null;
  if (Date.now() > entry.expiry) { delete CACHE[key]; return null; }
  return entry.data;
}

function cacheSet(key, data, ttlKey) {
  const ttl = CACHE_TTL[ttlKey] || 10 * 60 * 1000;
  CACHE[key] = { data, expiry: Date.now() + ttl };
}

// ── INSTRUMENTS ───────────────────────────────────────────────
async function getAllInstruments() {
  const cached = cacheGet('instruments');
  if (cached) return cached;
  const data = await storage.load('instruments.json') || {};
  cacheSet('instruments', data, 'instruments');
  return data;
}

async function getInstrument(symbol) {
  const all = await getAllInstruments();
  return all[symbol] || null;
}

async function saveInstrument(symbol, data) {
  const all = await getAllInstruments();
  all[symbol] = { ...all[symbol], ...data, updated_at: new Date().toISOString() };
  cacheSet('instruments', all, 'instruments');
  await storage.save('instruments.json', all);
}

async function bulkSaveInstruments(instruments) {
  const all = await getAllInstruments();
  const now = new Date().toISOString();
  Object.entries(instruments).forEach(([sym, data]) => {
    all[sym] = { ...all[sym], ...data, updated_at: now };
  });
  cacheSet('instruments', all, 'instruments');
  await storage.save('instruments.json', all);
  console.log(`Bulk saved ${Object.keys(instruments).length} instruments to B2`);
}

// ── UNIVERSE LISTS ────────────────────────────────────────────
async function getUniverse(list = 'nifty500') {
  const ckey = `universe_${list}`;
  const cached = cacheGet(ckey);
  if (cached) return cached;
  const data = await storage.load(`universe_${list}.json`);
  const symbols = data?.symbols || [];
  cacheSet(ckey, symbols, 'universe');
  return symbols;
}

async function saveUniverse(list, symbols) {
  const ckey = `universe_${list}`;
  cacheSet(ckey, symbols, 'universe');
  await storage.save(`universe_${list}.json`, {
    symbols,
    count:      symbols.length,
    updated_at: new Date().toISOString(),
  });
}

// ── SNAPSHOTS ─────────────────────────────────────────────────
async function saveSnapshot(data) {
  const snap = { ...data, saved_at: new Date().toISOString() };
  cacheSet('snapshot', snap, 'snapshot');
  await storage.save('snapshot_latest.json', snap);
}

async function getLatestSnapshot() {
  const cached = cacheGet('snapshot');
  if (cached) return cached;
  const data = await storage.load('snapshot_latest.json');
  if (data) cacheSet('snapshot', data, 'snapshot');
  return data;
}

// ── AI ANALYSIS ───────────────────────────────────────────────
async function saveAIAnalysis(data) {
  const analysis = { ...data, generated_at: new Date().toISOString() };
  cacheSet('ai_analysis', analysis, 'ai_analysis');
  await storage.save('ai_analysis_latest.json', analysis);
}

async function getLatestAIAnalysis() {
  const cached = cacheGet('ai_analysis');
  if (cached) return cached;
  const data = await storage.load('ai_analysis_latest.json');
  if (data) cacheSet('ai_analysis', data, 'ai_analysis');
  return data;
}

// ── NEWS ──────────────────────────────────────────────────────
async function saveNews(data) {
  const news = { ...data, saved_at: new Date().toISOString() };
  cacheSet('news', news, 'news');
  await storage.save('news_latest.json', news);
}

async function getLatestNews() {
  const cached = cacheGet('news');
  if (cached) return cached;
  const data = await storage.load('news_latest.json');
  if (data) cacheSet('news', data, 'news');
  return data;
}

// ── CALIBRATION ───────────────────────────────────────────────
async function saveCalibrationRun(data) {
  const cal = { ...data, saved_at: new Date().toISOString() };
  cacheSet('calibration', cal, 'calibration');
  await storage.save('calibration_latest.json', cal);
}

async function getLastCalibration() {
  const cached = cacheGet('calibration');
  if (cached) return cached;
  const data = await storage.load('calibration_latest.json');
  if (data) cacheSet('calibration', data, 'calibration');
  return data;
}

// ── PREFERENCES ───────────────────────────────────────────────
const DEFAULT_PREFS = {
  portfolio: {
    NET:  { qty: 1.066992, avg: 208.62, currency: 'USD' },
    CEG:  { qty: 0.714253, avg: 310.43, currency: 'USD' },
    GLNG: { qty: 3.489692, avg: 50.93,  currency: 'USD' },
  },
  watchlist: ['HAL', 'ONGC', 'TCS', 'PERSISTENT', 'BEL'],
  alert_thresholds: { price_move_pct: 3, fii_surge: 5000 },
  min_score_alert:  75,
};

async function getPreferences() {
  const cached = cacheGet('preferences');
  if (cached) return cached;
  const data = await storage.load('preferences.json');
  const prefs = data || DEFAULT_PREFS;
  cacheSet('preferences', prefs, 'preferences');
  return prefs;
}

async function savePreferences(data) {
  cacheSet('preferences', data, 'preferences');
  await storage.save('preferences.json', data);
}

// ── ALERTS & LOGS (fire and forget — no need to read back) ────
async function logAlert(data) {
  try {
    const existing = await storage.load('alerts_today.json') || { alerts: [] };
    existing.alerts.push({ ...data, sent_at: new Date().toISOString() });
    existing.date = new Date().toISOString().slice(0, 10);
    await storage.save('alerts_today.json', existing);
  } catch(e) {}
}

async function logScrapeRun(data) {
  try {
    await storage.save(`scrape_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`, {
      ...data, logged_at: new Date().toISOString(),
    });
  } catch(e) {}
}

// ── SEED MULTI-ASSET INSTRUMENTS ─────────────────────────────
async function seedMultiAssetInstruments() {
  const path = require('path');
  const fs   = require('fs');

  const candidates = [
    path.join(__dirname, 'shared/india_instruments_data.json'),
    path.join(__dirname, '../shared/india_instruments_data.json'),
    path.join(process.cwd(), 'shared/india_instruments_data.json'),
  ];
  const dataPath = candidates.find(p => fs.existsSync(p));
  if (!dataPath) { console.log('india_instruments_data.json not found'); return { seeded: 0 }; }

  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const all  = await getAllInstruments();
  let count  = 0;

  Object.entries(data).forEach(([symbol, inst]) => {
    all[symbol] = {
      ...inst, symbol,
      calibrated_at: new Date().toISOString(),
      calibration: {
        base_returns: {
          BULL: inst.expected_return_pct || inst.yield_pct || 8,
          SOFT_BULL: inst.expected_return_pct || inst.yield_pct || 7,
          SIDEWAYS:  inst.expected_return_pct || inst.yield_pct || 7,
          SOFT_BEAR: inst.expected_return_pct || inst.yield_pct || 7,
          BEAR:      inst.expected_return_pct || inst.yield_pct || 6,
        },
        sigma: { BULL: 0.02, SOFT_BULL: 0.02, SIDEWAYS: 0.01, SOFT_BEAR: 0.02, BEAR: 0.03 },
        source: 'multi_asset_static',
      },
    };
    count++;
  });

  cacheSet('instruments', all, 'instruments');
  await storage.save('instruments.json', all);
  console.log(`Seeded ${count} multi-asset instruments to B2`);
  return { seeded: count };
}

// ── BACKTEST ──────────────────────────────────────────────────
async function saveBacktest(data) {
  await storage.save('backtest_latest.json', { ...data, saved_at: new Date().toISOString() });
}

async function getBacktest() {
  return storage.load('backtest_latest.json');
}

// ── INIT (no-op for compatibility) ────────────────────────────
function init() { return {}; }

module.exports = {
  init,
  getAllInstruments, getInstrument, saveInstrument, bulkSaveInstruments,
  getUniverse, saveUniverse,
  saveSnapshot, getLatestSnapshot,
  saveAIAnalysis, getLatestAIAnalysis,
  saveNews, getLatestNews,
  saveCalibrationRun, getLastCalibration,
  logAlert, logScrapeRun,
  getPreferences, savePreferences,
  seedMultiAssetInstruments,
  saveBacktest, getBacktest,
};
