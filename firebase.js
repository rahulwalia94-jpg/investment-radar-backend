// ═══════════════════════════════════════════════════════════════
// Firebase Client — Phase 3
// Full Nifty 500 dynamic schema
// ═══════════════════════════════════════════════════════════════
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');

let db;

function init() {
  if (db) return db;
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  db = getFirestore();
  return db;
}

// ── INSTRUMENTS (Nifty 500 + US) ─────────────────────────────
async function getAllInstruments() {
  const db = init();
  const snap = await db.collection('instruments').get();
  const instruments = {};
  snap.docs.forEach(d => { instruments[d.id] = d.data(); });
  return instruments;
}

async function getInstrument(symbol) {
  const db = init();
  const doc = await db.collection('instruments').doc(symbol).get();
  return doc.exists ? doc.data() : null;
}

async function saveInstrument(symbol, data) {
  const db = init();
  await db.collection('instruments').doc(symbol).set({
    ...data,
    updated_at: Timestamp.now(),
  }, { merge: true });
}

async function bulkSaveInstruments(instruments) {
  const db = init();
  const batch = db.batch();
  Object.entries(instruments).forEach(([symbol, data]) => {
    const ref = db.collection('instruments').doc(symbol);
    batch.set(ref, { ...data, updated_at: Timestamp.now() }, { merge: true });
  });
  await batch.commit();
  console.log(`Bulk saved ${Object.keys(instruments).length} instruments`);
}

// ── UNIVERSE LISTS ────────────────────────────────────────────
async function getUniverse(list = 'nifty500') {
  const db = init();
  const doc = await db.collection('universe').doc(list).get();
  return doc.exists ? doc.data().symbols : [];
}

async function saveUniverse(list, symbols) {
  const db = init();
  await db.collection('universe').doc(list).set({
    symbols,
    count: symbols.length,
    updated_at: Timestamp.now(),
  });
}

// ── SNAPSHOTS (6x daily price + macro data) ──────────────────
async function saveSnapshot(data) {
  const db = init();
  const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  await db.collection('snapshots').doc(ts).set({ ...data, saved_at: Timestamp.now() });
  await db.collection('snapshots').doc('latest').set({ ...data, saved_at: Timestamp.now() });
}

async function getLatestSnapshot() {
  const db = init();
  const doc = await db.collection('snapshots').doc('latest').get();
  return doc.exists ? doc.data() : null;
}

// ── AI ANALYSIS ───────────────────────────────────────────────
async function saveAIAnalysis(data) {
  const db = init();
  const date = new Date().toISOString().slice(0, 10);
  await db.collection('ai_analysis').doc(date).set({ ...data, generated_at: Timestamp.now() });
  await db.collection('ai_analysis').doc('latest').set({ ...data, generated_at: Timestamp.now() });
}

async function getLatestAIAnalysis() {
  const db = init();
  const doc = await db.collection('ai_analysis').doc('latest').get();
  return doc.exists ? doc.data() : null;
}

// ── NEWS ──────────────────────────────────────────────────────
async function saveNews(data) {
  const db = init();
  const date = new Date().toISOString().slice(0, 10);
  await db.collection('news').doc(date).set({ ...data, saved_at: Timestamp.now() });
  await db.collection('news').doc('latest').set({ ...data, saved_at: Timestamp.now() });
}

async function getLatestNews() {
  const db = init();
  const doc = await db.collection('news').doc('latest').get();
  return doc.exists ? doc.data() : null;
}

// ── CALIBRATION LOG ───────────────────────────────────────────
async function saveCalibrationRun(data) {
  const db = init();
  const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  await db.collection('calibration_runs').doc(ts).set({ ...data, saved_at: Timestamp.now() });
  await db.collection('calibration_runs').doc('latest').set({ ...data, saved_at: Timestamp.now() });
}

async function getLastCalibration() {
  const db = init();
  const doc = await db.collection('calibration_runs').doc('latest').get();
  return doc.exists ? doc.data() : null;
}

// ── ALERTS ────────────────────────────────────────────────────
async function logAlert(data) {
  const db = init();
  const date = new Date().toISOString().slice(0, 10);
  const ref  = db.collection('alerts_sent').doc(date);
  await ref.set({
    date,
    alerts: FieldValue.arrayUnion({ ...data, sent_at: new Date().toISOString() }),
    updated_at: Timestamp.now(),
  }, { merge: true });
}

// ── PREFERENCES ───────────────────────────────────────────────
async function getPreferences() {
  const db = init();
  const doc = await db.collection('preferences').doc('user').get();
  if (doc.exists) return doc.data();
  return {
    portfolio: {
      NET:  { qty: 1.066992, avg: 208.62, currency: 'USD' },
      CEG:  { qty: 0.714253, avg: 310.43, currency: 'USD' },
      GLNG: { qty: 3.489692, avg: 50.93,  currency: 'USD' },
    },
    watchlist:  ['HAL', 'ONGC', 'TCS', 'PERSISTENT', 'BEL', 'GOLD ETF'],
    phone:      process.env.USER_PHONE || '',
    alert_thresholds: { price_move_pct: 3, fii_surge: 5000 },
    min_score_alert:  75,
  };
}

async function savePreferences(data) {
  const db = init();
  await db.collection('preferences').doc('user').set(data, { merge: true });
}

// ── SCRAPE LOGS ───────────────────────────────────────────────
async function logScrapeRun(data) {
  const db = init();
  const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  await db.collection('scrape_logs').doc(ts).set({ ...data, logged_at: Timestamp.now() });
}

// ── SEED MULTI-ASSET INSTRUMENTS ─────────────────────────────
async function seedMultiAssetInstruments() {
  const db = init();
  const path = require('path');
  const fs   = require('fs');

  // Load multi-asset data
  // Try all possible paths on Render
  const candidates = [
    path.join(__dirname, 'shared/india_instruments_data.json'),
    path.join(__dirname, '../shared/india_instruments_data.json'),
    path.join(process.cwd(), 'shared/india_instruments_data.json'),
    path.join(process.cwd(), 'backend/shared/india_instruments_data.json'),
  ];
  const dataPath = candidates.find(p => fs.existsSync(p));
  console.log('Seed: looking for india_instruments_data.json, found:', dataPath || 'NOT FOUND');
  console.log('Tried paths:', candidates);
  if (!dataPath) { return { seeded: 0, tried: candidates }; }

  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const batch = db.batch();
  let count = 0;

  Object.entries(data).forEach(([symbol, inst]) => {
    const ref = db.collection('instruments').doc(symbol);
    batch.set(ref, {
      ...inst,
      symbol,
      calibrated_at: new Date().toISOString(),
      // Default calibration for non-equity
      calibration: {
        base_returns: { BULL: inst.expected_return_pct || inst.yield_pct || 8,
                        SOFT_BULL: inst.expected_return_pct || inst.yield_pct || 7,
                        SIDEWAYS: inst.expected_return_pct || inst.yield_pct || 7,
                        SOFT_BEAR: inst.expected_return_pct || inst.yield_pct || 7,
                        BEAR: inst.expected_return_pct || inst.yield_pct || 6 },
        sigma: { BULL: 0.02, SOFT_BULL: 0.02, SIDEWAYS: 0.01, SOFT_BEAR: 0.02, BEAR: 0.03 },
        source: 'multi_asset_static',
      },
    }, { merge: true });
    count++;
  });

  await batch.commit();
  console.log(`Seeded ${count} multi-asset instruments to Firebase`);
  return { seeded: count };
}

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
};
