// ── MORNING REFRESH ────────────────────────────────────────────
// Runs 6× daily — fetches prices, scores all instruments
// Uses 5-layer master scorer (no Python dependency)

'use strict';

const fb         = require('../db');
const nse        = require('../scrapers/nse');
const { scoreAllInstruments } = require('../scoring/masterScorer');
const { buildCovarianceMatrix, loadCorrelationMatrix } = require('../scoring/dccModel');
const { simulatePaths, simulatePortfolio, simulateExpandedPortfolio } = require('../scoring/monteCarlo');
const { runBlackLitterman }      = require('../scoring/blOptimizer');
const { computeFactorScore }     = require('../scoring/factorModel');
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
    const fii = await nse.getFII();
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
    const movers = await nse.getMovers().catch(() => null);
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

  // ── 9c. LOAD PRE-COMPUTED CORRELATION MATRIX FROM B2 ────────
  let corrMatrixData = null;
  try {
    const storage  = require('../storage');
    corrMatrixData = await storage.load('correlation_matrix.json');
    if (corrMatrixData?.count > 0) {
      console.log(`Correlation matrix loaded: ${corrMatrixData.count} stocks`);
    } else {
      console.log('No correlation matrix in B2 — run local_calibrate.js to compute');
    }
  } catch(e) { console.log('Correlation matrix load error:', e.message); }

  // ── 9b. LOAD FUNDAMENTALS FROM B2 ────────────────────────────
  console.log('Loading fundamentals from B2...');
  let fundamentalsData = {};
  try {
    const storage = require('../storage');
    const fundRaw = await storage.load('fundamentals.json');
    if (fundRaw && Object.keys(fundRaw).length > 0) {
      fundamentalsData = fundRaw;
      console.log(`Fundamentals loaded: ${Object.keys(fundamentalsData).length} stocks`);
    }
  } catch(e) {
    console.log('Fundamentals load error:', e.message);
  }

  // ── 10. LOAD REGIME PERIODS ───────────────────────────────
  let regimePeriods = {};
  try {
    const cal = await fb.getLastCalibration();
    regimePeriods = cal?.regime_periods || {};

    // Always rebuild from Nifty 50 history if we have it
    const niftyHist = priceHistories['^NSEI'] || priceHistories['NIFTY50'] || 
                      priceHistories['%5ENSEI'] || [];
    if (niftyHist.length >= 60) {
      console.log(`Building regime periods from ${niftyHist.length} days of Nifty 50 history...`);
      const closes = niftyHist.map(h => h.close);
      niftyHist.forEach((bar, i) => {
        if (i < 50) return;
        const ma20  = closes.slice(i-20,i).reduce((s,v)=>s+v,0)/20;
        const ma50  = closes.slice(i-50,i).reduce((s,v)=>s+v,0)/50;
        const price = closes[i];
        let r;
        if      (price > ma20*1.03 && ma20 > ma50*1.01) r = 'BULL';
        else if (price > ma20*1.01)                      r = 'SOFT_BULL';
        else if (price > ma20*0.97)                      r = 'SIDEWAYS';
        else if (price > ma20*0.94)                      r = 'SOFT_BEAR';
        else                                             r = 'BEAR';
        regimePeriods[bar.date] = r;
      });
      const dist = {};
      Object.values(regimePeriods).forEach(r => { dist[r] = (dist[r]||0)+1; });
      console.log(`Regime periods: ${Object.keys(regimePeriods).length} days | ${JSON.stringify(dist)}`);
    } else {
      console.log('⚠️ No Nifty 50 history — using default regime periods');
    }
  } catch(e) { console.log('Regime periods error:', e.message); }

  // ── 11. SCORE WITH 5-LAYER MODEL ─────────────────────────
  console.log('Running 5-layer scoring model...');
  let scoringResult = null;
  try {
    scoringResult = await scoreAllInstruments(
      instruments, snap, newsData, priceHistories, regimePeriods, fundamentalsData
    );
    snap.success.push(`scored:${Object.keys(scoringResult.scores).length}`);
    console.log(`AI scored ${Object.keys(scoringResult.scores).length} instruments. Top 5: ${scoringResult.top5?.join(', ')}`);

    // ── Step 2: DCC Correlation Matrix ────────────────────────
    try {
      const portSyms = ['NET','CEG','GLNG'].filter(s => priceHistories[s]?.length >= 30);
      const top20    = (scoringResult.top20 || scoringResult.top5 || []).slice(0, 20)
                        .filter(s => priceHistories[s]?.length >= 30);
      const dccSyms  = [...new Set([...portSyms, ...top20])];

      let covResult = null;

      // Use pre-computed full matrix if available (fast path)
      if (corrMatrixData?.symbols?.length > 0) {
        covResult = loadCorrelationMatrix(corrMatrixData, dccSyms);
        console.log(`DCC: loaded from pre-computed matrix (${corrMatrixData.count} stocks)`);
      }

      // Fall back to computing on-the-fly for subset
      if (!covResult && dccSyms.length >= 3) {
        covResult = buildCovarianceMatrix(priceHistories, dccSyms, snap.regime);
        console.log(`DCC: computed on-the-fly for ${dccSyms.length} stocks`);
      }

      if (covResult) {
        const { cov, sigmas, corr } = covResult;
        scoringResult.dcc = {
          symbols: dccSyms,
          correlation: dccSyms.reduce((obj, sym, i) => ({
            ...obj,
            [sym]: dccSyms.reduce((o2, sym2, j) => ({
              ...o2, [sym2]: parseFloat((corr[i]?.[j]||0).toFixed(3))
            }), {})
          }), {}),
          covariance:   cov,
          sigmas:       dccSyms.reduce((obj, sym, i) => ({
            ...obj, [sym]: parseFloat(((sigmas[i]||0.25)*100).toFixed(2))
          }), {}),
          regime:       snap.regime,
          source:       corrMatrixData ? 'precomputed' : 'realtime',
          matrix_size:  corrMatrixData?.count || dccSyms.length,
        };

        // Log portfolio correlations
        if (portSyms.length >= 2) {
          portSyms.forEach((a,i) => portSyms.slice(i+1).forEach(b => {
            console.log(`  ${a}-${b}: ${scoringResult.dcc.correlation[a]?.[b]?.toFixed(3)||'?'}`);
          }));
        }
      }
    } catch(e) { console.log('DCC error:', e.message); }

    // ── Step 3: Monte Carlo — Correlated Paths via Cholesky ──
    try {
      const PORTFOLIO = [
        { sym:'NET',  qty:1.066992, avgCost:208.62 },
        { sym:'CEG',  qty:0.714253, avgCost:310.43 },
        { sym:'GLNG', qty:3.489692, avgCost:50.93  },
      ];
      const usdInr   = snap.usdInr || 86;
      const mcResults= {};

      // Individual stock simulations (10,000 paths each)
      for (const h of PORTFOLIO) {
        const hist      = priceHistories[h.sym] || [];
        const sc        = scoringResult?.scores?.[h.sym] || {};
        const cal       = sc.calibration || {};
        const lastPrice = hist[hist.length-1]?.close || snap.usPrices?.[h.sym] || h.avgCost;
        const sigma     = cal.sigma?.[snap.regime]         || 0.30;
        const expRet    = cal.base_returns?.[snap.regime]  || 0;

        const mc = simulatePaths({
          currentPrice: lastPrice, expectedReturn: expRet,
          sigma, days: 90, paths: 10000, regime: snap.regime,
        });

        mcResults[h.sym] = {
          ...mc,
          avg_cost:    h.avgCost,
          qty:         h.qty,
          current_inr: Math.round(lastPrice * h.qty * usdInr),
          pl_pct:      parseFloat(((lastPrice - h.avgCost) / h.avgCost * 100).toFixed(1)),
          holding:     true,
        };
      }

      // Correlated portfolio simulation using full Cholesky
      if (scoringResult.dcc?.covariance) {
        const dcc      = scoringResult.dcc;
        const portSyms = PORTFOLIO.map(h=>h.sym).filter(s=>dcc.symbols?.includes(s));

        if (portSyms.length >= 2) {
          // Build sub-covariance for portfolio stocks
          const portIdx  = portSyms.map(s => dcc.symbols.indexOf(s));
          const subCov   = portIdx.map(i => portIdx.map(j => dcc.covariance?.[i]?.[j] || 0));
          const portHold = portSyms.map(sym => {
            const h    = PORTFOLIO.find(p=>p.sym===sym);
            const hist = priceHistories[sym] || [];
            const price= hist[hist.length-1]?.close || snap.usPrices?.[sym] || h.avgCost;
            return { sym, value: price * h.qty * usdInr };
          });
          const expRets  = portSyms.map(s => {
            const cal = scoringResult.scores?.[s]?.calibration || {};
            return cal.base_returns?.[snap.regime] || 0;
          });

          // 10,000 correlated paths
          const portMC = simulatePortfolio(portHold, subCov, portSyms, expRets, 90, 10000);
          if (portMC) {
            mcResults._portfolio = { ...portMC, usdInr, cholesky_used: true };
            console.log(`Portfolio MC (Cholesky): win=${portMC.win_probability}% | VaR95=₹${Math.round(portMC.var_95).toLocaleString()}`);
          }
        }
      }

      scoringResult.monte_carlo = mcResults;
      const { NET:net, CEG:ceg, GLNG:glng } = mcResults;
      console.log(`Monte Carlo: NET win=${net?.win_probability}% | CEG win=${ceg?.win_probability}% | GLNG win=${glng?.win_probability}%`);
    } catch(e) { console.log('Monte Carlo error:', e.message); }

    // ── Step 4: Black-Litterman Portfolio Optimizer ───────────
    try {
      if (scoringResult.dcc && Object.keys(scoringResult.scores).length > 5) {
        const blSyms = scoringResult.dcc?.symbols || [];
        if (blSyms.length >= 3) {
          const blResult = runBlackLitterman({
            symbols:         blSyms,
            covMatrix:       scoringResult.dcc.covariance,
            sigmas:          blSyms.map((s,i) => scoringResult.dcc.covariance?.[i]?.[i] ? Math.sqrt(scoringResult.dcc.covariance[i][i]) : 0.25),
            scores:          scoringResult.scores,
            metaData:        {},
            priceHistories,
            regime:          snap.regime,
            currentHoldings: {
              NET:  { qty: 1.066992, avgCost: 208.62 },
              CEG:  { qty: 0.714253, avgCost: 310.43 },
              GLNG: { qty: 3.489692, avgCost: 50.93  },
            },
            usdInr: snap.usdInr || 86,
          });

          if (blResult) {
            scoringResult.bl_result = blResult;
            console.log(`Black-Litterman: top pick = ${blResult.top_pick} | Sharpe = ${blResult.portfolio_metrics?.sharpe_ratio}`);
            console.log(`  Optimal weights: ${JSON.stringify(blResult.optimal_weights)}`);
          }
        }
      }
    } catch(e) { console.log('Black-Litterman error:', e.message); }

    // ── Step 5: Factor Model enrichment ───────────────────────
    try {
      const marketHistory = priceHistories['^NSEI'] || priceHistories['%5ENSEI'] || [];
      let factorCount = 0;
      const portSyms  = ['NET','CEG','GLNG'];
      portSyms.forEach(sym => {
        const hist  = priceHistories[sym] || [];
        const score = scoringResult?.scores?.[sym];
        if (!score || hist.length < 60) return;
        const factor = computeFactorScore(sym, hist, marketHistory, fundamentalsData?.[sym]);
        score.factor_detail = factor;
        factorCount++;
      });
      if (factorCount > 0) console.log(`Factor model: enriched ${factorCount} portfolio stocks`);

      // Log FinBERT status
      const sampleScore = Object.values(scoringResult?.scores || {}).find(s => s?.layers?.news?.source);
      const newsSource  = sampleScore?.layers?.news?.source || 'unknown';
      console.log(`News scoring: ${newsSource === 'finbert' ? '✅ FinBERT (85% accuracy)' : '⚠️ keyword fallback (62%)'}`);
      if (newsSource !== 'finbert' && process.env.HF_TOKEN) {
        console.log('  HF_TOKEN present but FinBERT not responding — model may be loading');
      } else if (!process.env.HF_TOKEN) {
        console.log('  Add HF_TOKEN to Render env to enable FinBERT');
      }
    } catch(e) { console.log('Factor model error:', e.message); };
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
    const fii      = await nse.getFII();
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
