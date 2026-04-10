// ═══════════════════════════════════════════════════════════════
// MORNING REFRESH v3 — Memory-safe architecture
//
// DESIGN PRINCIPLE:
//   Morning refresh NEVER loads full price history (175MB = OOM)
//   It uses pre-computed calibration.json (~130KB) instead
//   Price history only loaded during recalibration (weekly, phone button)
//
// MEMORY BUDGET: ~226MB of 512MB Render limit
//   calibration.json      0.1MB
//   correlation_matrix    1.2MB
//   fundamentals          1.0MB
//   news                  2.0MB
//   instruments           1.0MB
//   ^NSEI history         0.5MB  (regime periods only)
//   Node.js runtime     150.0MB
//   Scoring working      50.0MB
//   DCC + MC + BL        20.0MB
//   TOTAL               225.8MB ✅
// ═══════════════════════════════════════════════════════════════
'use strict';

const fb      = require('../db');
const storage = require('../storage');
const https   = require('https');
const zlib    = require('zlib');

// ── YAHOO FETCH ───────────────────────────────────────────────
function fetchYahoo(symbol, days = 5) {
  return new Promise(resolve => {
    const to   = Math.floor(Date.now() / 1000);
    const from = to - days * 24 * 3600;
    const req  = https.get({
      hostname: 'query1.finance.yahoo.com',
      path:     `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${from}&period2=${to}`,
      headers:  { 'User-Agent':'Mozilla/5.0', 'Accept-Encoding':'gzip' },
      timeout:  12000,
    }, res => {
      const bufs = [];
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') stream = res.pipe(zlib.createGunzip());
      stream.on('data', c => bufs.push(c));
      stream.on('end', () => {
        try {
          const d     = JSON.parse(Buffer.concat(bufs).toString());
          const meta  = d?.chart?.result?.[0]?.meta || {};
          const price = parseFloat((meta.regularMarketPrice || 0).toFixed(2));
          const prev  = parseFloat((meta.chartPreviousClose || price).toFixed(2));
          const chg   = prev > 0 ? parseFloat(((price - prev) / prev * 100).toFixed(2)) : 0;
          // For regime periods: return full timestamps + closes
          const result = d?.chart?.result?.[0];
          const ts     = result?.timestamp || [];
          const closes = result?.indicators?.quote?.[0]?.close || [];
          const history = ts.map((t, i) => ({
            date:  new Date(t * 1000).toISOString().slice(0, 10),
            close: parseFloat((closes[i] || 0).toFixed(2)),
          })).filter(b => b.close > 0);
          resolve({ price, prev, chg, history });
        } catch(e) { resolve({ price:0, prev:0, chg:0, history:[] }); }
      });
      stream.on('error', () => resolve({ price:0, prev:0, chg:0, history:[] }));
    });
    req.on('error',   () => resolve({ price:0, prev:0, chg:0, history:[] }));
    req.on('timeout', () => { req.destroy(); resolve({ price:0, prev:0, chg:0, history:[] }); });
  });
}

// ── BUILD REGIME PERIODS from price history ───────────────────
function buildRegimePeriods(hist) {
  const periods = {};
  if (!hist || hist.length < 60) return periods;
  const cls = hist.map(h => h.close);
  hist.forEach((bar, i) => {
    if (i < 50) return;
    const ma20 = cls.slice(i-20, i).reduce((s,v) => s+v, 0) / 20;
    const ma50 = cls.slice(i-50, i).reduce((s,v) => s+v, 0) / 50;
    const px   = cls[i];
    periods[bar.date] =
      px > ma20*1.03 && ma20 > ma50*1.01 ? 'BULL'      :
      px > ma20*1.01                      ? 'SOFT_BULL' :
      px > ma20*0.97                      ? 'SIDEWAYS'  :
      px > ma20*0.94                      ? 'SOFT_BEAR' : 'BEAR';
  });
  return periods;
}

// ── DETECT CURRENT REGIME ─────────────────────────────────────
function detectRegime(vix, fiiNet, niftyChg) {
  let score = 0;
  if (vix > 30)       score -= 5;
  else if (vix > 25)  score -= 3;
  else if (vix > 20)  score -= 1;
  else if (vix < 14)  score += 3;
  else if (vix < 17)  score += 1;
  if (fiiNet < -4000)      score -= 4;
  else if (fiiNet < -1500) score -= 2;
  else if (fiiNet <  0)    score -= 1;
  else if (fiiNet > 3000)  score += 3;
  else if (fiiNet > 1000)  score += 1;
  if (niftyChg < -2)      score -= 2;
  else if (niftyChg < -1) score -= 1;
  else if (niftyChg > 1.5) score += 2;
  else if (niftyChg > 0.5) score += 1;
  if (score >= 5)  return { regime:'BULL',      score };
  if (score >= 2)  return { regime:'SOFT_BULL',  score };
  if (score >= -1) return { regime:'SIDEWAYS',   score };
  if (score >= -4) return { regime:'SOFT_BEAR',  score };
  return                   { regime:'BEAR',       score };
}

// ── MAIN REFRESH ─────────────────────────────────────────────
async function runMorningRefresh() {
  const t0 = Date.now();
  console.log(`\n${'='.repeat(55)}`);
  console.log(`MORNING REFRESH v3 — ${new Date().toISOString()}`);
  console.log('='.repeat(55));

  const snap = { ts:new Date().toISOString(), errors:[], success:[], prices:{}, usPrices:{} };

  // ── STEP 1: KEY PRICES FROM YAHOO ────────────────────────────
  // Fetch VIX, Nifty, portfolio stocks — small parallel requests
  console.log('Step 1: Fetching key prices from Yahoo...');
  const YAHOO_SYMS = [
    '^VIX', '^NSEI', '^GSPC', '^TNX', 'USDINR=X',
    'NET',  'CEG',   'GLNG',
    'GLD',  'TLT',   'CL=F', 'BZ=F', 'BTC-USD',
    'NVDA', 'MSFT',  'AAPL', 'SPY',  'QQQ', 'EEM',
  ];

  const yahooResults = await Promise.all(
    YAHOO_SYMS.map(sym => fetchYahoo(sym, 5).then(r => ({ sym, ...r })))
  );

  let usdInr = 86, niftyChg = 0;
  const indices = {};

  yahooResults.forEach(({ sym, price, chg }) => {
    if (!price || price <= 0) return;
    switch(sym) {
      case '^VIX':     indices.vix    = price; break;
      case '^NSEI':    indices.nifty  = price; niftyChg = chg; break;
      case '^GSPC':    indices.spx    = price; break;
      case '^TNX':     indices.us10yr = price; break;
      case 'USDINR=X': usdInr = price > 10 ? price : 86; indices.usdInr = usdInr; break;
      default:         snap.usPrices[sym] = price;
    }
  });

  snap.indices = indices;
  snap.usdInr  = usdInr;
  console.log(`  VIX=${indices.vix||'?'} Nifty=${indices.nifty||'?'} (${niftyChg>0?'+':''}${niftyChg}%) USD/INR=${usdInr}`);
  console.log(`  US prices: ${Object.keys(snap.usPrices).join(', ')}`);

  // ── STEP 2: NSE FII DATA ─────────────────────────────────────
  console.log('Step 2: Fetching FII data...');
  try {
    const nse    = require('../scrapers/nse');
    const fiiRaw = await nse.getFII().catch(() => null);
    if (fiiRaw && typeof fiiRaw === 'object') {
      const dates  = Object.keys(fiiRaw).sort().reverse();
      const latest = fiiRaw[dates[0]] || fiiRaw;
      snap.fii = {
        fii_net: parseFloat(latest.fii_net || latest.FII_NET || latest.fiinet || 0),
        dii_net: parseFloat(latest.dii_net || latest.DII_NET || latest.diinet || 0),
      };
    } else {
      snap.fii = { fii_net:0, dii_net:0 };
    }
    console.log(`  FII: ₹${snap.fii.fii_net}Cr | DII: ₹${snap.fii.dii_net}Cr`);
  } catch(e) {
    snap.fii = { fii_net:0, dii_net:0 };
    snap.errors.push('fii:' + e.message.slice(0,30));
    console.log('  FII unavailable:', e.message.slice(0,40));
  }

  // ── STEP 3: REGIME DETECTION ─────────────────────────────────
  const { regime, score: regScore } = detectRegime(
    snap.indices?.vix || 18,
    snap.fii?.fii_net || 0,
    niftyChg
  );
  snap.regime       = regime;
  snap.regime_score = regScore;
  console.log(`Step 3: Regime = ${regime} (score ${regScore})`);

  // ── STEP 4: REGIME PERIODS from ^NSEI long history ───────────
  // Fetch 2yr Nifty history from Yahoo for regime period tagging
  // 2yr = ~500 bars = tiny memory footprint
  console.log('Step 4: Building regime periods from Nifty 2yr history...');
  let regimePeriods = {};
  try {
    const niftyLong = await fetchYahoo('^NSEI', 730); // 2 years
    regimePeriods   = buildRegimePeriods(niftyLong.history);
    const dist      = {};
    Object.values(regimePeriods).forEach(r => { dist[r] = (dist[r]||0)+1; });
    console.log(`  Regime periods: ${Object.keys(regimePeriods).length} days`);
    console.log(`  Distribution: ${JSON.stringify(dist)}`);
  } catch(e) {
    console.log('  Regime periods unavailable:', e.message.slice(0,40));
  }

  // ── STEP 5: LOAD SMALL FILES FROM B2 ─────────────────────────
  // All tiny files — total ~6MB
  console.log('Step 5: Loading calibration + metadata from B2...');
  let calibration = {}, instruments = {}, fundamentals = {}, newsData = { stocks:{}, market:[] };

  [calibration, instruments, fundamentals, newsData] = await Promise.all([
    storage.load('calibration.json').catch(() => ({})),
    fb.getAllInstruments().catch(() => ({})),
    storage.load('fundamentals.json').catch(() => ({})),
    fb.getLatestNews().catch(() => ({ stocks:{}, market:[] })),
  ]);

  // Also try loading correlation matrix (sigmas only for memory safety)
  let corrMatrix = null;
  try {
    const rawCorr = await storage.load('correlation_matrix.json');
    if (rawCorr?.symbols) {
      corrMatrix = {
        symbols: rawCorr.symbols,
        sigmas:  rawCorr.sigmas  || {},
        corr:    rawCorr.symbols.length <= 50 ? rawCorr.corr : null, // only load full if small
        count:   rawCorr.count,
      };
    }
  } catch(e) {}

  console.log(`  Calibration: ${Object.keys(calibration).length} stocks`);
  console.log(`  Instruments: ${Object.keys(instruments).length}`);
  console.log(`  News: ${Object.keys(newsData?.stocks||{}).length} stocks`);
  console.log(`  Fundamentals: ${Object.keys(fundamentals).length}`);

  if (Object.keys(instruments).length === 0) {
    console.error('No instruments loaded — aborting');
    return { snap, analysis:null };
  }

  // ── STEP 6: SCORE ALL STOCKS ──────────────────────────────────
  // Uses calibration.json — NO raw price history loaded
  // calibration has sigma/base_returns/sharpe/momentum pre-computed
  console.log(`Step 6: Scoring ${Object.keys(instruments).length} stocks...`);
  let scoringResult = null;

  try {
    const { scoreOne } = require('../scoring/masterScorer');
    const symList   = Object.keys(instruments);
    const allScores = {};
    const BATCH     = 50;

    // Market history = regime periods proxy (no history needed in scoreOne)
    for (let i = 0; i < symList.length; i += BATCH) {
      const batch = symList.slice(i, i + BATCH);
      await Promise.all(batch.map(async sym => {
        const inst = { ...instruments[sym] };
        // Inject calibration so GARCH layer uses pre-computed values
        if (calibration[sym]) inst.calibration = calibration[sym];
        if (snap.usPrices[sym]) inst.last_price = snap.usPrices[sym];
        try {
          allScores[sym] = await scoreOne(
            inst, snap, newsData,
            [], null,          // empty history — calibration handles it
            regimePeriods, fundamentals
          );
          // Override calibration in result to ensure correct sigma/returns
          if (calibration[sym]) {
            allScores[sym].calibration = calibration[sym];
            if (allScores[sym].layers?.quant) {
              Object.assign(allScores[sym].layers.quant, calibration[sym]);
            }
          }
        } catch(e) {
          allScores[sym] = {
            symbol:sym, score:50, signal:'HOLD',
            reason:`error: ${e.message.slice(0,30)}`,
            sector:inst.sector||'', country:inst.country||'IN',
            layers:{}, calibration:calibration[sym]||{},
            last_price:inst.last_price||0,
          };
        }
      }));
      if ((i + BATCH) % 200 === 0) {
        console.log(`  Scored ${Math.min(i+BATCH, symList.length)}/${symList.length}`);
      }
    }

    // Sort + top lists
    const sorted = Object.entries(allScores).sort(([,a],[,b]) => b.score - a.score);
    const top5   = sorted.slice(0, 5).map(([s]) => s);
    const top20  = sorted.slice(0, 20).map(([s]) => s);

    // Active geo flags
    const activeFlags = {};
    Object.values(allScores).forEach(r => {
      (r.layers?.geo?.flags || []).forEach(f => {
        if (!activeFlags[f.flag]) activeFlags[f.flag] = { ...f, count:0 };
        activeFlags[f.flag].count++;
      });
    });

    // ── DCC (from pre-computed correlation matrix) ────────────
    let dccResult = null;
    try {
      const dcc     = require('../scoring/dccModel');
      const portSyms= ['NET','CEG','GLNG'].filter(s => allScores[s]);
      const dccSyms = [...new Set([...portSyms, ...top20.slice(0,12)])].filter(s => allScores[s]);
      const sigmaMap= {};
      dccSyms.forEach(s => {
        const cal = calibration[s] || allScores[s]?.calibration || {};
        sigmaMap[s] = (cal.sigma?.[regime] || cal.current_vol/100 || 0.25);
      });
      const covData = dcc.diagonalCov(dccSyms, sigmaMap); // safe fallback
      dccResult = {
        symbols:     dccSyms,
        correlation: dcc.buildCorrObject(dccSyms, covData.corr),
        covariance:  covData.cov,
        sigmas:      dccSyms.reduce((o,s,i)=>({...o,[s]:parseFloat((covData.sigmas[i]*100).toFixed(1))}),{}),
        source:      'calibration_sigmas',
        regime,
      };
    } catch(e) { console.log('DCC error:', e.message); }

    // ── MONTE CARLO (portfolio) ───────────────────────────────
    let mcResults = {};
    try {
      const mc       = require('../scoring/monteCarlo');
      const PORTFOLIO= [
        { sym:'NET',  qty:1.066992, avg:208.62 },
        { sym:'CEG',  qty:0.714253, avg:310.43 },
        { sym:'GLNG', qty:3.489692, avg:50.93  },
      ];
      for (const h of PORTFOLIO) {
        const cal    = calibration[h.sym] || {};
        const price  = snap.usPrices[h.sym] || h.avg;
        const sigma  = cal.sigma?.[regime]        || 0.30;
        const expRet = cal.base_returns?.[regime] || 0;
        mcResults[h.sym] = {
          ...mc.simulatePaths({ currentPrice:price, expectedReturn:expRet, sigma, days:90, paths:10000, regime }),
          avg_cost: h.avg, qty: h.qty,
          current_inr: Math.round(price * h.qty * usdInr),
          pl_pct: parseFloat(((price - h.avg) / h.avg * 100).toFixed(1)),
        };
      }
      // Portfolio Cholesky
      if (dccResult) {
        const portSyms = PORTFOLIO.map(h=>h.sym).filter(s=>dccResult.symbols.includes(s));
        const portHoldings = PORTFOLIO.filter(h=>portSyms.includes(h.sym)).map(h=>({
          sym:h.sym, value:(snap.usPrices[h.sym]||h.avg) * h.qty * usdInr,
        }));
        const portIdx = portSyms.map(s=>dccResult.symbols.indexOf(s));
        const subCov  = portIdx.map(i=>portIdx.map(j=>dccResult.covariance?.[i]?.[j]||0));
        const expRets = portSyms.map(s=>calibration[s]?.base_returns?.[regime]||0);
        mcResults._portfolio = {
          ...mc.simulatePortfolio(portHoldings, subCov, portSyms, expRets, 90, 10000),
          cholesky_used: true, usdInr,
        };
      }
      console.log(`MC: NET=${mcResults.NET?.win_probability}% CEG=${mcResults.CEG?.win_probability}% GLNG=${mcResults.GLNG?.win_probability}%`);
    } catch(e) { console.log('MC error:', e.message); }

    // ── BLACK-LITTERMAN ───────────────────────────────────────
    let blResult = null;
    try {
      if (dccResult && top20.length >= 5) {
        const bl     = require('../scoring/blOptimizer');
        const blSyms = top20.filter(s=>dccResult.symbols.includes(s)).slice(0,15);
        const blIdx  = blSyms.map(s=>dccResult.symbols.indexOf(s));
        const blCov  = blIdx.map(i=>blIdx.map(j=>dccResult.covariance?.[i]?.[j]||0));
        blResult = bl.run({ symbols:blSyms, covMatrix:blCov, scores:allScores, regime,
          holdings:[{sym:'NET'},{sym:'CEG'},{sym:'GLNG'}] });
        if (blResult) console.log(`BL: top_pick=${blResult.top_pick} sharpe=${blResult.portfolio_metrics?.sharpe_ratio?.toFixed(2)}`);
      }
    } catch(e) { console.log('BL error:', e.message); }

    scoringResult = {
      scores:      allScores,
      top5, top20,
      geo_signals: { active_flags: activeFlags },
      dcc:         dccResult,
      monte_carlo: mcResults,
      bl_result:   blResult,
      model:       'six-layer-v3-calibration',
      scored_at:   new Date().toISOString(),
    };

    snap.success.push(`scored:${symList.length}`);
    console.log(`\nScoring complete. Top 5: ${top5.join(', ')}`);
  } catch(e) {
    console.error('Scoring fatal:', e.message, e.stack?.split('\n')[1]);
    snap.errors.push('scoring:' + e.message.slice(0,40));
  }

  // ── STEP 7: SAVE ─────────────────────────────────────────────
  const analysis = {
    scores:           scoringResult,
    regime_narrative: `${regime} regime. VIX ${indices.vix||'?'}. FII ₹${snap.fii?.fii_net||0}Cr. Nifty ${niftyChg>0?'+':''}${niftyChg}%.`,
    portfolio_signal: scoringResult?.scores?.NET?.signal || 'HOLD',
  };

  await fb.saveSnapshot(snap);
  await fb.saveAIAnalysis(analysis);

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n✅ Morning refresh done in ${elapsed}s`);
  console.log(`   Regime: ${regime} (${regScore}) | VIX: ${indices.vix} | FII: ₹${snap.fii?.fii_net}Cr`);
  console.log(`   Scored: ${Object.keys(scoringResult?.scores||{}).length} stocks`);
  console.log(`   Top 5: ${scoringResult?.top5?.join(', ')}`);

  return { snap, analysis };
}

// ── RECALIBRATION (triggered from phone button) ───────────────
// Loads full price history — ONLY safe because it's a one-off
// on a fresh Render instance with nothing else in memory
async function runRecalibration() {
  const t0 = Date.now();
  console.log('\nRECALIBRATION v3 — refit GARCH on B2 price history');

  const { computeStock } = require('../scoring/garchEngine');
  const calibration = {};
  let processed = 0;

  // Load index to know how many chunks
  const idx = await storage.load('price_history_index.json');
  if (!idx || !idx.chunks) {
    return { ok:false, error:'No price history index in B2' };
  }

  console.log(`Processing ${idx.chunks} chunks...`);

  // Load regime periods from ^NSEI (fetch fresh from Yahoo)
  const niftyData = await new Promise(resolve => {
    // Use fetchYahoo with 18yr
    const from = Math.floor(new Date('2008-01-01').getTime()/1000);
    const to   = Math.floor(Date.now()/1000);
    const req  = https.get({
      hostname:'query1.finance.yahoo.com',
      path:`/v8/finance/chart/%5ENSEI?interval=1d&period1=${from}&period2=${to}`,
      headers:{'User-Agent':'Mozilla/5.0','Accept-Encoding':'gzip'},timeout:30000,
    }, res => {
      const bufs=[];
      let stream=res;
      if(res.headers['content-encoding']==='gzip') stream=res.pipe(zlib.createGunzip());
      stream.on('data',c=>bufs.push(c));
      stream.on('end',()=>{
        try{
          const d=JSON.parse(Buffer.concat(bufs).toString());
          const ts=d?.chart?.result?.[0]?.timestamp||[];
          const cl=d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close||[];
          resolve(ts.map((t,i)=>({date:new Date(t*1000).toISOString().slice(0,10),close:cl[i]||0})).filter(b=>b.close>0));
        }catch(e){resolve([]);}
      });
    });
    req.on('error',()=>resolve([]));
    req.on('timeout',()=>{req.destroy();resolve([]);});
  });

  const regimePeriods = {};
  if (niftyData.length > 60) {
    const cls = niftyData.map(h=>h.close);
    niftyData.forEach((bar,i)=>{
      if(i<50) return;
      const ma20=cls.slice(i-20,i).reduce((s,v)=>s+v,0)/20;
      const ma50=cls.slice(i-50,i).reduce((s,v)=>s+v,0)/50;
      const px=cls[i];
      regimePeriods[bar.date]=px>ma20*1.03&&ma20>ma50*1.01?'BULL':px>ma20*1.01?'SOFT_BULL':px>ma20*0.97?'SIDEWAYS':px>ma20*0.94?'SOFT_BEAR':'BEAR';
    });
    console.log(`Regime periods: ${Object.keys(regimePeriods).length} days from Nifty ${niftyData.length} bars`);
  }

  // Process one chunk at a time — load, calibrate, discard
  for (let i = 0; i < idx.chunks; i++) {
    console.log(`Chunk ${i+1}/${idx.chunks}...`);
    const chunk = await storage.load(`price_history_${i}.json`) || {};
    for (const [sym, hist] of Object.entries(chunk)) {
      if (!hist || hist.length < 30) continue;
      calibration[sym] = {
        ...computeStock(hist, regimePeriods),
        calibrated_at: new Date().toISOString(),
      };
      processed++;
    }
    // Explicitly free chunk memory
    Object.keys(chunk).forEach(k => delete chunk[k]);
  }

  await storage.save('calibration.json', calibration);
  const elapsed = Math.round((Date.now()-t0)/1000);
  console.log(`✅ Recalibration done in ${elapsed}s | ${processed} stocks calibrated`);
  return { ok:true, count:processed, elapsed };
}

module.exports = { runMorningRefresh, runRecalibration };
