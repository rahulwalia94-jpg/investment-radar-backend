// ═══════════════════════════════════════════════════════════════
// MORNING REFRESH v2 — Clean orchestration
// Dependency order: data → regime → score → dcc → mc → bl
// Mobile-friendly: /api/calibrate triggers recalibration only
// ═══════════════════════════════════════════════════════════════
'use strict';

const fb      = require('../db');
const storage = require('../storage');
const { scoreAll } = require('../scoring/masterScorer');

// ── REGIME BUILDER ────────────────────────────────────────────
function buildRegime(hist) {
  const p = {};
  if (!hist || hist.length < 60) return p;
  const cls = hist.map(h => h.close);
  hist.forEach((bar, i) => {
    if (i < 50) return;
    const ma20 = cls.slice(i-20, i).reduce((s,v)=>s+v,0) / 20;
    const ma50 = cls.slice(i-50, i).reduce((s,v)=>s+v,0) / 50;
    const px   = cls[i];
    p[bar.date] = px>ma20*1.03&&ma20>ma50*1.01 ? 'BULL'
                : px>ma20*1.01                   ? 'SOFT_BULL'
                : px>ma20*0.97                   ? 'SIDEWAYS'
                : px>ma20*0.94                   ? 'SOFT_BEAR'
                :                                  'BEAR';
  });
  return p;
}

// ── CURRENT REGIME ────────────────────────────────────────────
function detectRegime(snap) {
  const vix = snap?.indices?.vix || 18;
  const fii = snap?.fii?.fii_net || 0;
  let score = 0;
  if (vix > 28) score -= 4; else if (vix > 22) score -= 2; else if (vix < 14) score += 3;
  if (fii < -3000) score -= 4; else if (fii < -1000) score -= 2; else if (fii > 2000) score += 3;
  if (score >= 5)  return { regime:'BULL',      score };
  if (score >= 2)  return { regime:'SOFT_BULL',  score };
  if (score >= -1) return { regime:'SIDEWAYS',   score };
  if (score >= -4) return { regime:'SOFT_BEAR',  score };
  return { regime:'BEAR', score };
}

// ── MAIN REFRESH ──────────────────────────────────────────────
async function runMorningRefresh() {
  const t0 = Date.now();
  console.log(`\n${'='.repeat(55)}`);
  console.log(`MORNING REFRESH v2 — ${new Date().toISOString()}`);
  console.log('='.repeat(55));

  // ── 1. MARKET DATA (prices, FII, indices) ─────────────────
  let snap = { ts: new Date().toISOString(), errors:[], success:[] };
  try {
    const market = require('../jobs/marketData');
    Object.assign(snap, await market.fetchAll());
    console.log(`Prices: NSE=${Object.keys(snap.prices||{}).length} US=${Object.keys(snap.usPrices||{}).length}`);
  } catch(e) {
    snap.errors.push('market:' + e.message.slice(0,40));
    console.error('Market data error:', e.message);
  }

  // ── 2. REGIME DETECTION ───────────────────────────────────
  const { regime, score: regimeScore } = detectRegime(snap);
  snap.regime       = regime;
  snap.regime_score = regimeScore;
  console.log(`Regime: ${regime} (score ${regimeScore})`);

  // ── 3. LOAD FROM B2 ───────────────────────────────────────
  console.log('Loading B2 data...');

  // Price histories
  let priceHistories = {};
  try {
    priceHistories = await fb.getAllPriceHistories() || {};
    console.log(`  Price histories: ${Object.keys(priceHistories).length} stocks`);
  } catch(e) { snap.errors.push('prices:' + e.message.slice(0,30)); }

  // Correlation matrix
  let corrMatrixData = null;
  try {
    corrMatrixData = await storage.load('correlation_matrix.json');
    if (corrMatrixData?.count) console.log(`  Correlation matrix: ${corrMatrixData.count} stocks`);
  } catch(e) { console.log('  No correlation matrix in B2'); }

  // Fundamentals
  let fundamentalsData = {};
  try {
    fundamentalsData = await storage.load('fundamentals.json') || {};
    console.log(`  Fundamentals: ${Object.keys(fundamentalsData).length} stocks`);
  } catch(e) { console.log('  No fundamentals in B2'); }

  // News
  let newsData = { stocks:{}, market:[] };
  try {
    newsData = await fb.getLatestNews() || newsData;
    console.log(`  News: ${Object.keys(newsData.stocks||{}).length} stocks`);
  } catch(e) { console.log('  No news data'); }

  // Instruments
  let instruments = {};
  try {
    const allInst = await fb.getAllInstruments() || {};
    instruments   = allInst;
    console.log(`  Instruments: ${Object.keys(instruments).length}`);
  } catch(e) { snap.errors.push('instruments:' + e.message.slice(0,30)); }

  if (Object.keys(instruments).length === 0) {
    console.error('No instruments loaded — aborting');
    return { snap, analysis:null };
  }

  // ── 4. REGIME PERIODS ─────────────────────────────────────
  let regimePeriods = {};
  const niftyHist = priceHistories['^NSEI'] || priceHistories['%5ENSEI'] || [];
  const spHist    = priceHistories['^GSPC'] || priceHistories['SPY'] || [];
  const niftyP    = buildRegime(niftyHist);
  const spP       = buildRegime(spHist);
  regimePeriods   = { ...spP, ...niftyP }; // Nifty overrides SP500 for shared dates
  const dist      = {};
  Object.values(regimePeriods).forEach(r => { dist[r]=(dist[r]||0)+1; });
  console.log(`Regime periods: ${Object.keys(regimePeriods).length} | ${JSON.stringify(dist)}`);
  console.log(`  Nifty: ${Object.keys(niftyP).length} | SP500: ${Object.keys(spP).length}`);

  // ── 5. SCORE ALL ──────────────────────────────────────────
  let scoringResult = null;
  try {
    scoringResult = await scoreAll(
      instruments, snap, newsData,
      priceHistories, regimePeriods,
      fundamentalsData, corrMatrixData
    );
    snap.success.push(`scored:${Object.keys(scoringResult.scores).length}`);
  } catch(e) {
    console.error('Scoring fatal:', e.message);
    snap.errors.push('scoring:' + e.message.slice(0,40));
  }

  // ── 6. SAVE ───────────────────────────────────────────────
  const analysis = {
    scores:           scoringResult,
    regime_narrative: `${regime} regime. VIX ${snap.indices?.vix||'?'}. FII ₹${snap.fii?.fii_net||0}Cr.`,
    portfolio_signal: scoringResult?.scores?.NET?.signal || 'HOLD',
  };

  await fb.saveSnapshot(snap);
  await fb.saveAIAnalysis(analysis);

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n✅ Morning refresh done in ${elapsed}s`);
  console.log(`   Regime: ${regime} (${regimeScore})`);
  console.log(`   Top 5: ${scoringResult?.top5?.join(', ') || 'none'}`);

  return { snap, analysis };
}

// ── RECALIBRATION (mobile-friendly, no price fetching) ────────
async function runRecalibration() {
  const t0 = Date.now();
  console.log('\nRECALIBRATION — refit GARCH on existing B2 data');

  const priceHistories = await fb.getAllPriceHistories() || {};
  console.log(`Loaded ${Object.keys(priceHistories).length} price histories`);

  const niftyHist = priceHistories['^NSEI'] || [];
  const spHist    = priceHistories['^GSPC'] || [];
  const niftyP    = buildRegime(niftyHist);
  const spP       = buildRegime(spHist);
  const regimePeriods = { ...spP, ...niftyP };
  console.log(`Regime periods: ${Object.keys(regimePeriods).length}`);

  // Re-compute GARCH calibration for all stocks
  const { computeStock } = require('../scoring/garchEngine');
  const calibration = {};
  Object.entries(priceHistories).forEach(([sym, hist]) => {
    if (!hist || hist.length < 30) return;
    calibration[sym] = { ...computeStock(hist, regimePeriods), calibrated_at: new Date().toISOString() };
  });

  await storage.save('calibration.json', calibration);
  console.log(`✅ Recalibration done in ${Math.round((Date.now()-t0)/1000)}s | ${Object.keys(calibration).length} stocks`);
  return { ok:true, count:Object.keys(calibration).length };
}

module.exports = { runMorningRefresh, runRecalibration };
