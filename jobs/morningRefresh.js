// ── MORNING REFRESH ────────────────────────────────────────────
// Runs 6× daily — fetches prices, scores all instruments
// Uses 5-layer master scorer (no Python dependency)

'use strict';

const fb         = require('../db');
const nse        = require('../scrapers/nse');
const { scoreAllInstruments } = require('../scoring/masterScorer');
const ai         = require('../ai');
const fcm        = require('../fcm');
const tg         = require('../telegram');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── LABEL FOR THIS REFRESH ────────────────────────────────────
function getSnapshotLabel() {
  const h = new Date().getUTCHours();
  const m = new Date().getUTCMinutes();
  const t = h * 60 + m;
  if (t < 210)  return 'US Close 1:30 AM IST';
  if (t < 330)  return 'India Pre-Open';
  if (t < 390)  return 'India Open 9:00 AM IST';
  if (t < 540)  return 'India Midday 12:00 PM IST';
  if (t < 570)  return 'India Close 3:00 PM IST';
  if (t < 810)  return 'US Open 7:00 PM IST';
  if (t < 1020) return 'US Midday 10:00 PM IST';
  return 'After Hours';
}

// ── MAIN ──────────────────────────────────────────────────────
async function runMorningRefresh() {
  const t0 = Date.now();
  console.log('\n' + '='.repeat(50));
  console.log(`MORNING REFRESH — ${new Date().toISOString()}`);
  console.log('='.repeat(50));

  const label = getSnapshotLabel();
  const snap  = {
    ts:      new Date().toISOString(),
    label,
    regime:  'SIDEWAYS',
    errors:  [],
    success: [],
    model:   'five-layer-v1',
  };

  // ── 1. LOAD INSTRUMENTS FROM B2 ──────────────────────────
  console.log('Loading instruments from B2...');
  let instruments = {};
  try {
    instruments = await fb.getAllInstruments();
    console.log(`Loaded ${Object.keys(instruments).length} instruments`);
    if (Object.keys(instruments).length === 0) {
      console.log('No instruments — triggering recalibration first');
      const { runWeeklyRecalibration } = require('./weeklyRecalibration');
      await runWeeklyRecalibration();
      instruments = await fb.getAllInstruments();
    }
  } catch(e) {
    console.log('Instrument load error:', e.message);
    snap.errors.push('instruments:' + e.message.slice(0,50));
  }

  // ── 2. FETCH NSE BULK QUOTES ──────────────────────────────
  console.log('Fetching NSE bulk quotes...');
  try {
    const allSymbols = Object.keys(instruments).filter(k => instruments[k].country !== 'US');
    const chunks     = [];
    for (let i = 0; i < allSymbols.length; i += 100) chunks.push(allSymbols.slice(i, i+100));

    for (const chunk of chunks) {
      const quotes = await nse.getBulkQuotes(chunk);
      if (quotes) {
        Object.entries(quotes).forEach(([sym, q]) => {
          if (instruments[sym] && q.price) instruments[sym].last_price = q.price;
        });
        snap.success.push(`prices:${Object.keys(quotes).length}`);
        console.log(`  Prices: ${Object.keys(quotes).length}/${chunk.length}`);
      }
      await sleep(1000);
    }
  } catch(e) {
    console.log('NSE quotes error:', e.message);
    snap.errors.push('quotes:' + e.message.slice(0,50));
  }

  // ── 3. FETCH US PRICES ────────────────────────────────────
  console.log('Fetching US prices...');
  try {
    const macro = await nse.getMacro();
    if (macro.usdInr) {
      snap.usdInr   = macro.usdInr;
      snap.brent    = macro.brent;
      snap.gold     = macro.gold;
    }
    if (macro.usPrices) {
      snap.usPrices = macro.usPrices;
      Object.entries(macro.usPrices).forEach(([sym, price]) => {
        if (instruments[sym]) instruments[sym].last_price = price;
      });
      snap.success.push(`us_prices:${Object.keys(macro.usPrices).length}`);
    }
  } catch(e) {
    console.log('US prices error:', e.message);
    snap.errors.push('us_prices:' + e.message.slice(0,50));
  }

  // ── 4. FETCH FII DATA ─────────────────────────────────────
  try {
    const fii = await nse.getFIIData();
    if (fii) {
      snap.fii = fii;
      snap.success.push('fii:ok');
    }
  } catch(e) {
    snap.errors.push('fii:' + e.message.slice(0,30));
  }

  // ── 5. FETCH INDICES ──────────────────────────────────────
  try {
    const indices = await nse.getIndices();
    if (indices) {
      snap.indices = indices;
      snap.success.push('indices:ok');
    }
  } catch(e) {
    snap.errors.push('indices:' + e.message.slice(0,30));
  }

  // ── 6. DETECT REGIME ──────────────────────────────────────
  try {
    const niftyLast  = snap.indices?.['NIFTY 50']?.last || 0;
    const niftyPrev  = snap.indices?.['NIFTY 50']?.previousClose || niftyLast;
    const fii        = snap.fii?.fii_net || 0;
    const vix        = snap.indices?.['INDIA VIX']?.last || 17;

    // Simple regime from VIX + FII + momentum
    const pChange    = niftyPrev > 0 ? (niftyLast - niftyPrev) / niftyPrev * 100 : 0;
    let regime       = 'SIDEWAYS';

    if      (fii < -5000 && vix > 22)  regime = 'BEAR';
    else if (fii < -2000 && vix > 18)  regime = 'SOFT_BEAR';
    else if (fii > 5000  && vix < 15)  regime = 'BULL';
    else if (fii > 2000  && vix < 18)  regime = 'SOFT_BULL';
    else if (vix > 25)                  regime = 'BEAR';
    else if (vix < 12 && fii > 0)      regime = 'BULL';

    snap.regime       = regime;
    snap.regime_score = Math.round(fii / 1000) || 0;
    snap.success.push('regime:' + regime);
  } catch(e) {
    snap.errors.push('regime:' + e.message.slice(0,30));
  }

  // ── 7. FETCH GAINERS / LOSERS ─────────────────────────────
  try {
    const movers = await nse.getTopMovers();
    if (movers) { snap.gainers = movers.gainers; snap.losers = movers.losers; }
  } catch(e) { /* optional */ }

  // ── 8. LOAD NEWS ──────────────────────────────────────────
  console.log('Loading news from B2...');
  let newsData = { stocks: {}, market: [] };
  try {
    newsData = await fb.getLatestNews() || newsData;
  } catch(e) { snap.errors.push('news:' + e.message.slice(0,30)); }

  // ── 9. LOAD PRICE HISTORIES (stored separately in B2) ───────
  console.log('Loading price histories from B2...');
  let priceHistories = {};
  try {
    priceHistories = await fb.getAllPriceHistories();
    console.log(`Price histories loaded: ${Object.keys(priceHistories).length} stocks`);
    if (Object.keys(priceHistories).length === 0) {
      console.log('No price histories found — recalibration needed');
      snap.errors.push('no_price_history');
    }
  } catch(e) {
    console.log('Price history load error:', e.message);
    snap.errors.push('history:' + e.message.slice(0,30));
  }

  // ── 10. LOAD REGIME PERIODS ───────────────────────────────
  let regimePeriods = {};
  try {
    const cal = await fb.getLastCalibration();
    regimePeriods = cal?.regime_periods || {};
  } catch(e) { /* optional */ }

  // ── 11. SCORE WITH 5-LAYER MODEL ─────────────────────────
  console.log('Running 5-layer scoring model...');
  let scoringResult = null;
  try {
    scoringResult = await scoreAllInstruments(
      instruments, snap, newsData, priceHistories, regimePeriods
    );
    snap.success.push(`scored:${Object.keys(scoringResult.scores).length}`);
    console.log(`AI scored ${Object.keys(scoringResult.scores).length} instruments. Top 5: ${scoringResult.top5?.join(', ')}`);
  } catch(e) {
    console.log('Scoring error:', e.message);
    snap.errors.push('scoring:' + e.message.slice(0,50));
    // Haiku fallback
    try {
      console.log('Running Haiku fallback...');
      await runHaikuFallback(snap, instruments);
    } catch(e2) {
      snap.errors.push('haiku_fallback:' + e2.message.slice(0,50));
    }
  }

  // ── 12. AI NARRATIVES ─────────────────────────────────────
  let analysis = {};
  try {
    const narrative = await ai.generateRegimeNarrative(snap, scoringResult?.scores, scoringResult?.geo_signals);
    const portSig   = await ai.getPortfolioSignal(snap, scoringResult?.scores);
    analysis = {
      regimeNarrative: narrative,
      portfolioSignal: portSig,
      scores:          scoringResult,
      chains:          await ai.getDominoChains(snap, scoringResult?.scores, scoringResult?.geo_signals),
      geo_signals:     scoringResult?.geo_signals || {},
    };
  } catch(e) {
    console.log('AI narrative error:', e.message);
    snap.errors.push('narrative:' + e.message.slice(0,50));
  }

  // ── 13. SAVE ──────────────────────────────────────────────
  await fb.saveSnapshot(snap);
  await fb.saveAIAnalysis(analysis);

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n✅ Morning refresh done in ${elapsed}s`);
  console.log(`   Regime: ${snap.regime} (${snap.regime_score})`);
  console.log(`   Prices: ${snap.success.filter(s=>s.startsWith('prices')).join(', ')}`);
  if (snap.errors.length > 0) console.log(`   Errors: ${snap.errors.join(', ')}`);

  // ── 14. NOTIFICATIONS ─────────────────────────────────────
  try {
    const prefs = await fb.getPreferences();
    if (prefs?.fcmToken) await fcm.sendMorningBrief(snap, analysis, prefs.portfolio);
  } catch(e) { console.log('FCM error:', e.message); }

  try {
    await tg.sendMorningBrief(snap, analysis, {}).catch(e => console.log('Telegram:', e.message));
  } catch(e) { /* optional */ }

  return { snap, analysis };
}

// ── HAIKU FALLBACK (if master scorer fails) ───────────────────
async function runHaikuFallback(snap, instruments) {
  try {
    const result = await ai.scoreAllInstruments(snap, instruments);
    const analysis = {
      regimeNarrative: await ai.generateRegimeNarrative(snap, result?.scores),
      portfolioSignal: await ai.getPortfolioSignal(snap, result?.scores),
      scores: result,
    };
    await fb.saveSnapshot(snap);
    await fb.saveAIAnalysis(analysis);
    console.log('Haiku fallback complete ✅');
  } catch(e) {
    console.log('Haiku fallback error:', e.message);
  }
}

// ── MIDDAY UPDATE (lightweight) ──────────────────────────────
async function runMiddayUpdate() {
  console.log(`\n🔄 Running midday update: ${new Date().toISOString()}`);
  try {
    const prevSnap = await fb.getLatestSnapshot();
    const macro    = await nse.getMacro();
    const fii      = await nse.getFIIData();
    const indices  = await nse.getIndices();

    const snap = {
      ...prevSnap,
      ts:       new Date().toISOString(),
      usdInr:   macro?.usdInr  || prevSnap?.usdInr,
      brent:    macro?.brent   || prevSnap?.brent,
      usPrices: macro?.usPrices|| prevSnap?.usPrices || {},
      fii:      fii            || prevSnap?.fii,
      indices:  indices        || prevSnap?.indices,
    };

    await fb.saveSnapshot(snap);
    console.log(`Midday update done | USD/INR: ${snap.usdInr?.toFixed(2)} | Regime: ${snap.regime}`);
  } catch(e) {
    console.log('Midday update error:', e.message);
  }
}

module.exports = { runMorningRefresh, runMiddayUpdate };
