// ── WEEKLY RECALIBRATION ───────────────────────────────────────
// Fetches price history via Stooq (works from cloud IPs)
// Incremental: only 14 days if data exists, else 365 days
// Stores price history in Backblaze B2

'use strict';

const fb      = require('../db');
const stooq   = require('../scrapers/nse');  // uses Yahoo Finance chart API
const nse     = require('../scrapers/nse');
const screener= require('../scrapers/screener');
const { US_UNIVERSE } = require('../shared/us_instruments');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── REGIME CLASSIFICATION ─────────────────────────────────────
function classifyRegimePeriods(niftyHistory) {
  if (!niftyHistory || niftyHistory.length < 60) return {};

  const periods = {};
  const closes  = niftyHistory.map(d => d.close);
  const N       = closes.length;

  for (let i = 20; i < N; i++) {
    const date     = niftyHistory[i].date;
    const ma20     = closes.slice(i-20, i).reduce((s,v)=>s+v,0)/20;
    const ma50     = i>=50 ? closes.slice(i-50,i).reduce((s,v)=>s+v,0)/50 : ma20;
    const price    = closes[i];
    const pct20d   = (price - closes[i-20]) / closes[i-20] * 100;

    if      (price > ma20*1.03 && ma20 > ma50*1.01) periods[date] = 'BULL';
    else if (price > ma20*1.01)                      periods[date] = 'SOFT_BULL';
    else if (price > ma20*0.97)                      periods[date] = 'SIDEWAYS';
    else if (price > ma20*0.94)                      periods[date] = 'SOFT_BEAR';
    else                                             periods[date] = 'BEAR';
  }

  const dist = {};
  Object.values(periods).forEach(r => { dist[r] = (dist[r]||0)+1; });
  console.log(`Regime periods classified: ${Object.keys(periods).length} days`);
  console.log(`Regime distribution: ${JSON.stringify(dist)}`);

  return periods;
}

// ── MAIN RECALIBRATION ────────────────────────────────────────
async function runWeeklyRecalibration() {
  const startTime = Date.now();
  console.log('\n' + '='.repeat(60));
  console.log('WEEKLY RECALIBRATION STARTED');
  console.log('='.repeat(60));

  // Incremental check
  const existingCal  = await fb.getLastCalibration().catch(() => null);
  const existingInst = await fb.getAllInstruments().catch(() => ({}));
  const hasExisting  = Object.keys(existingInst || {}).length > 100;
  const FETCH_DAYS   = hasExisting ? 14 : 365;
  console.log(`  Mode: ${hasExisting ? `INCREMENTAL (${FETCH_DAYS} days)` : 'FULL (365 days)'}`);

  const stats = {
    total: 0, calibrated: 0, errors: [], skipped: [],
    started_at: new Date().toISOString(),
  };

  // ── 1. NIFTY 500 LIST ────────────────────────────────────
  console.log('\n[1/5] Fetching Nifty 500 list...');
  let nifty500 = [];
  try {
    const raw500 = await nse.getNifty500List();
    nifty500 = Array.isArray(raw500) ? raw500 : Object.values(raw500 || {});
    console.log(`Nifty 500: ${nifty500.length} stocks`);
    await fb.saveUniverse({ nifty500 });
  } catch(e) {
    console.log('Nifty500 error:', e.message);
    // Use existing instruments as fallback
    const existing = await fb.getAllInstruments().catch(() => ({}));
    nifty500 = Object.values(existing)
      .filter(i => i.country === 'IN' || !i.country)
      .map(i => ({ symbol: i.symbol||i.nse, name: i.name, sector: i.sector }))
      .filter(i => i.symbol);
    console.log(`Using ${nifty500.length} existing India instruments`);
  }

  // ── 2. REGIME CLASSIFICATION ─────────────────────────────
  console.log('\n[2/5] Classifying regimes from Nifty 50 history...');
  let regimePeriods = {};
  try {
    const niftyHist = await stooq.getPriceHistory('^NSEI', null, null, 365);
    if (niftyHist && niftyHist.length >= 60) {
      regimePeriods = classifyRegimePeriods(niftyHist);
    } else {
      // Fallback: use NSEI (Nifty 50 on Stooq)
      const nsei = await stooq.getPriceHistory('NSEI', null, null, 365);
      if (nsei && nsei.length >= 60) regimePeriods = classifyRegimePeriods(nsei);
    }
  } catch(e) {
    console.log('Regime classification error:', e.message);
  }

  // ── 3. SCREENER VALUATIONS (top 200 only) ────────────────
  console.log('\n[3/5] Fetching Screener valuations (top 200)...');
  const top200     = nifty500.slice(0, 200).map(s => s.symbol);
  let valuations   = {};
  try {
    const result = await screener.getBatchValuations(top200, 400);
    valuations   = result.valuations || {};
    console.log(`  Valuations: ${Object.keys(valuations).length} fetched`);
  } catch(e) {
    console.log('Screener error:', e.message);
  }

  // ── 4. INDIA STOCKS — price history via Stooq ────────────
  console.log(`\n[4/5] Calibrating ${nifty500.length} India stocks via Stooq...`);

  const calibrated = {};
  const priceHistories = {};

  // Process in batches of 20 with delays
  const BATCH = 20;
  for (let i = 0; i < nifty500.length; i += BATCH) {
    const batch = nifty500.slice(i, i + BATCH);

    // Sequential within batch — avoid rate limits
    for (const stock of batch) {
      try {
        const history = await stooq.getPriceHistory(stock.symbol, null, null, FETCH_DAYS);

        // Debug first few
        if (stats.calibrated + stats.skipped.length < 3) {
          console.log(`  DEBUG ${stock.symbol}: history=${history ? history.length + ' rows' : 'NULL'}`);
        }

        if (!history || history.length < 10) {
          stats.skipped.push(stock.symbol);
          // Save with fallback calibration
          calibrated[stock.symbol] = buildFallback(stock, valuations);
          continue;
        }

        // Merge with existing if incremental
        let fullHistory = history;
        if (hasExisting && existingInst[stock.symbol]?._price_history?.length > 0) {
          const existing = existingInst[stock.symbol]._price_history;
          // Append new bars, deduplicate by date
          const existingDates = new Set(existing.map(h => h.date));
          const newBars = history.filter(h => !existingDates.has(h.date));
          fullHistory = [...existing, ...newBars].slice(-252); // keep last 252
        }

        priceHistories[stock.symbol] = fullHistory;

        calibrated[stock.symbol] = buildCalibrated(stock, fullHistory, regimePeriods, valuations);
        stats.calibrated++;

      } catch(e) {
        stats.errors.push({ symbol: stock.symbol, error: e.message });
        calibrated[stock.symbol] = buildFallback(stock, valuations);
      }

      await sleep(300); // 300ms between requests
    }

    // Save batch progress
    await fb.bulkSaveInstruments(calibrated);
    console.log(`  Progress: ${Math.min(i + BATCH, nifty500.length)}/${nifty500.length} | Calibrated: ${stats.calibrated}`);
    await sleep(1000); // 1s between batches
  }

  // ── 5. US STOCKS ─────────────────────────────────────────
  console.log('\n[5/5] Calibrating US stocks via Stooq...');
  const usInstruments = {};

  for (const [sym, meta] of Object.entries(US_UNIVERSE || {})) {
    try {
      const history = await stooq.getPriceHistory(sym, null, null, FETCH_DAYS);

      if (!history || history.length < 10) {
        usInstruments[sym] = buildUSFallback(sym, meta);
        continue;
      }

      let fullHistory = history;
      if (hasExisting && existingInst[sym]?._price_history?.length > 0) {
        const existing     = existingInst[sym]._price_history;
        const existingDates= new Set(existing.map(h => h.date));
        const newBars      = history.filter(h => !existingDates.has(h.date));
        fullHistory        = [...existing, ...newBars].slice(-252);
      }

      priceHistories[sym]  = fullHistory;
      usInstruments[sym]   = buildUSCalibrated(sym, meta, fullHistory, regimePeriods);
      stats.calibrated++;

    } catch(e) {
      usInstruments[sym] = buildUSFallback(sym, meta);
    }
    await sleep(300);
  }

  await fb.bulkSaveInstruments(usInstruments);
  console.log(`  US stocks calibrated: ${Object.keys(usInstruments).length}`);

  // Save calibration run metadata
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  // Save price histories SEPARATELY (not inside instruments.json)
  if (Object.keys(priceHistories).length > 0) {
    console.log(`Saving ${Object.keys(priceHistories).length} price histories to B2...`);
    await fb.savePriceHistories(priceHistories);
  }

  // Strip _price_history from instruments before saving (keep instruments.json small)
  const cleanInstruments = {};
  Object.entries({ ...calibrated, ...usInstruments }).forEach(([sym, inst]) => {
    const { _price_history, ...clean } = inst;
    cleanInstruments[sym] = clean;
  });

  await fb.saveCalibrationRun({
    total:     nifty500.length + Object.keys(US_UNIVERSE||{}).length,
    calibrated:stats.calibrated,
    skipped:   stats.skipped.length,
    errors:    stats.errors.length,
    elapsed,
    instruments: cleanInstruments,
    regime_periods: regimePeriods,
    completed_at: new Date().toISOString(),
  });

  console.log('\n' + '='.repeat(60));
  console.log('RECALIBRATION COMPLETE');
  console.log(`  Total:      ${stats.calibrated + stats.skipped.length}`);
  console.log(`  Calibrated: ${stats.calibrated}`);
  console.log(`  Skipped:    ${stats.skipped.length}`);
  console.log(`  Errors:     ${stats.errors.length}`);
  console.log(`  Time:       ${Math.floor(elapsed/60)}m ${elapsed%60}s`);
  console.log('='.repeat(60));

  return { ok: true, calibrated: stats.calibrated };
}

// ── HELPERS ───────────────────────────────────────────────────
function calcSigma(history, regimePeriods) {
  const DEFAULTS = { BULL:0.22, SOFT_BULL:0.26, SIDEWAYS:0.20, SOFT_BEAR:0.30, BEAR:0.42 };
  if (!history || history.length < 20) return DEFAULTS;

  // Tag bars with regime
  history.forEach(bar => { bar._regime = regimePeriods?.[bar.date]; });

  const regimeRets = { BULL:[], SOFT_BULL:[], SIDEWAYS:[], SOFT_BEAR:[], BEAR:[] };
  for (let i=1;i<history.length;i++) {
    const r = history[i]._regime;
    if (!r || !regimeRets[r]) continue;
    const ret = (history[i].close - history[i-1].close) / history[i-1].close;
    regimeRets[r].push(ret);
  }

  const sigma = { ...DEFAULTS };
  Object.entries(regimeRets).forEach(([regime, rets]) => {
    if (rets.length < 10) return;
    const mean = rets.reduce((s,r)=>s+r,0)/rets.length;
    const variance = rets.reduce((s,r)=>s+(r-mean)**2,0)/rets.length;
    sigma[regime] = parseFloat(Math.sqrt(variance*252).toFixed(4));
  });
  return sigma;
}

function calcBaseReturns(history, regimePeriods) {
  const DEFAULTS = { BULL:20, SOFT_BULL:10, SIDEWAYS:3, SOFT_BEAR:-5, BEAR:-15 };
  if (!history || history.length < 20) return DEFAULTS;

  history.forEach(bar => { bar._regime = regimePeriods?.[bar.date]; });
  const regimeRets = { BULL:[], SOFT_BULL:[], SIDEWAYS:[], SOFT_BEAR:[], BEAR:[] };
  for (let i=1;i<history.length;i++) {
    const r = history[i]._regime;
    if (!r || !regimeRets[r]) continue;
    const ret = (history[i].close - history[i-1].close) / history[i-1].close;
    regimeRets[r].push(ret);
  }

  const bReturns = { ...DEFAULTS };
  Object.entries(regimeRets).forEach(([regime, rets]) => {
    if (rets.length < 10) return;
    const ann = (rets.reduce((s,r)=>s+r,0)/rets.length) * 252 * 100;
    bReturns[regime] = parseFloat(ann.toFixed(1));
  });
  return bReturns;
}

function buildCalibrated(stock, history, regimePeriods, valuations) {
  const sigma      = calcSigma(history, regimePeriods);
  const bReturns   = calcBaseReturns(history, regimePeriods);
  const closes     = history.map(h => h.close);
  const lastPrice  = closes[closes.length-1] || 0;
  const week52High = Math.max(...closes.slice(-252));
  const week52Low  = Math.min(...closes.slice(-252));

  return {
    symbol:      stock.symbol,
    name:        stock.name,
    sector:      stock.sector,
    nse:         stock.symbol,
    country:     'IN',
    last_price:  lastPrice,
    week52_high: week52High,
    week52_low:  week52Low,
    calibration: { sigma, base_returns: bReturns, source: 'calculated', history_days: history.length },
    valuation:   valuations[stock.symbol] || null,
    calibrated_at: new Date().toISOString(),
    _price_history: history.slice(-252),
  };
}

function buildFallback(stock, valuations) {
  return {
    symbol:    stock.symbol, name: stock.name, sector: stock.sector,
    nse:       stock.symbol, country: 'IN', last_price: stock.lastPrice || 0,
    calibration: {
      sigma:        { BULL:0.22, SOFT_BULL:0.26, SIDEWAYS:0.20, SOFT_BEAR:0.30, BEAR:0.42 },
      base_returns: { BULL:20,   SOFT_BULL:10,   SIDEWAYS:3,    SOFT_BEAR:-5,   BEAR:-15  },
      source: 'fallback', history_days: 0,
    },
    valuation:   valuations[stock.symbol] || null,
    calibrated_at: new Date().toISOString(),
  };
}

function buildUSCalibrated(sym, meta, history, regimePeriods) {
  const sigma    = calcSigma(history, regimePeriods);
  const bReturns = calcBaseReturns(history, regimePeriods);
  const closes   = history.map(h => h.close);
  const lastPrice= closes[closes.length-1] || 0;

  return {
    symbol:     sym, name: meta.name, sector: meta.sector,
    country:    'US', last_price: lastPrice,
    calibration:{ sigma, base_returns: bReturns, source: 'calculated', history_days: history.length },
    calibrated_at: new Date().toISOString(),
    _price_history: history.slice(-252),
  };
}

function buildUSFallback(sym, meta) {
  return {
    symbol: sym, name: meta?.name, sector: meta?.sector, country: 'US', last_price: 0,
    calibration: {
      sigma:        { BULL:0.28, SOFT_BULL:0.24, SIDEWAYS:0.22, SOFT_BEAR:0.32, BEAR:0.45 },
      base_returns: { BULL:25,   SOFT_BULL:12,   SIDEWAYS:5,    SOFT_BEAR:-8,   BEAR:-18  },
      source: 'fallback', history_days: 0,
    },
    calibrated_at: new Date().toISOString(),
  };
}

module.exports = { runWeeklyRecalibration };
