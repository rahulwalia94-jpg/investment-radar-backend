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
    const nse = require('../scrapers/nse');

    // NSE bulk quotes — get all instrument symbols
    const allSymbols = Object.keys(await fb.getAllInstruments().catch(()=>({})))
      .filter(s => !s.startsWith('^') && !s.includes('=') && !s.includes('-'));
    console.log(`Fetching NSE quotes for ${allSymbols.length} symbols...`);

    const [nseQuotes, fiiData] = await Promise.allSettled([
      nse.getBulkQuotes(allSymbols.slice(0, 500)).catch(() => ({})),
      nse.getFII().catch(() => null),
    ]);

    // Build prices map — getBulkQuotes returns {sym: price} directly
    const prices    = {};
    const rawQuotes = nseQuotes.value || {};
    Object.entries(rawQuotes).forEach(([sym, data]) => {
      // Handle both formats: direct number or object with price field
      const price = typeof data === 'number' ? data
        : data?.lastPrice || data?.close || data?.ltp || data?.price || 0;
      if (price > 0) prices[sym] = parseFloat(price);
    });
    snap.prices = prices;

    // FII data
    const fiiRaw = fiiData.value;
    if (fiiRaw) {
      const today = fiiRaw[Object.keys(fiiRaw)[0]];
      snap.fii = {
        fii_net: today?.fii_net || today?.FII_NET || 0,
        dii_net: today?.dii_net || today?.DII_NET || 0,
      };
    } else {
      snap.fii = { fii_net:0, dii_net:0 };
    }

    // Indices from prices
    snap.indices = {
      nifty:     prices['^NSEI']    || prices['NIFTY50'] || 0,
      sensex:    prices['^BSESN']   || 0,
      vix:       prices['^VIX']     || snap.indices?.vix || 18,
      bankNifty: prices['^NSEBANK'] || 0,
    };

    // US prices via Yahoo
    const usPrices = {};
    const US_SYMS  = ['NET','CEG','GLNG','NVDA','MSFT','AAPL','SPY','QQQ','GLD','TLT',
                      'CL=F','BZ=F','BTC-USD','^GSPC','^VIX','^TNX'];
    const https    = require('https');

    await Promise.all(US_SYMS.map(async sym => {
      try {
        const toTs   = Math.floor(Date.now()/1000);
        const fromTs = toTs - 2*24*3600;
        const price  = await new Promise(resolve => {
          const req = https.get({
            hostname: 'query1.finance.yahoo.com',
            path: `/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&period1=${fromTs}&period2=${toTs}`,
            headers: { 'User-Agent':'Mozilla/5.0', 'Accept':'application/json' },
            timeout: 10000,
          }, res => {
            const bufs = [];
            res.on('data', c => bufs.push(c));
            res.on('end', () => {
              try {
                const d = JSON.parse(Buffer.concat(bufs).toString());
                resolve(d?.chart?.result?.[0]?.meta?.regularMarketPrice || 0);
              } catch(e) { resolve(0); }
            });
          });
          req.on('error', () => resolve(0));
          req.on('timeout', () => { req.destroy(); resolve(0); });
        });
        if (price > 0) {
          usPrices[sym] = price;
          // Also update indices from Yahoo
          if (sym === '^VIX') snap.indices.vix = price;
          if (sym === '^GSPC') snap.indices.spx = price;
          if (sym === 'CL=F') snap.indices.oil = price;
          if (sym === 'BZ=F') snap.indices.brent = price;
          if (sym === '^TNX') snap.indices.us10yr = price;
        }
      } catch(e) {}
    }));

    snap.usPrices = usPrices;
    snap.usdInr   = prices['USDINR=X'] || usPrices['USDINR=X'] || 86;

    console.log(`Prices: NSE=${Object.keys(prices).length} US=${Object.keys(usPrices).length} FII=₹${snap.fii?.fii_net||0}Cr VIX=${snap.indices?.vix}`);
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

  // Load index only (not full price data) — saves memory
  let priceIndex = null;
  try {
    priceIndex = await storage.load('price_history_index.json');
    if (priceIndex?.count) console.log(`  Price history index: ${priceIndex.count} stocks in ${priceIndex.chunks} chunks`);
  } catch(e) { console.log('  No price history index'); }

  // Correlation matrix — load sigmas only if full matrix too large
  let corrMatrixData = null;
  try {
    const corrIdx = await storage.load('correlation_matrix.json');
    if (corrIdx?.count) {
      // Only load sigmas and symbols — not the full NxN matrix (too large)
      corrMatrixData = { symbols: corrIdx.symbols, sigmas: corrIdx.sigmas,
                         count: corrIdx.count, computed_at: corrIdx.computed_at };
      // Load corr matrix only if small enough (<200 stocks)
      if (corrIdx.count <= 200) corrMatrixData.corr = corrIdx.corr;
      console.log(`  Correlation matrix: ${corrIdx.count} stocks (${corrIdx.count<=200?'full':'sigmas only'})`);
    }
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
    instruments = await fb.getAllInstruments() || {};
    console.log(`  Instruments: ${Object.keys(instruments).length}`);
  } catch(e) { snap.errors.push('instruments:' + e.message.slice(0,30)); }

  if (Object.keys(instruments).length === 0) {
    console.error('No instruments loaded — aborting');
    return { snap, analysis:null };
  }

  // Load price histories in chunks — process and discard to save RAM
  // Build a lazy loader: only loads chunk when needed
  const priceChunkCache = {};
  async function getPriceHistory(sym) {
    if (!priceIndex) return [];
    // Find which chunk this symbol is in
    for (let i = 0; i < priceIndex.chunks; i++) {
      if (!priceChunkCache[i]) {
        priceChunkCache[i] = await storage.load(`price_history_${i}.json`) || {};
      }
      if (priceChunkCache[i][sym]) return priceChunkCache[i][sym];
    }
    return [];
  }

  // Pre-load all chunks but process sequentially
  console.log('  Loading price histories (chunked)...');
  const priceHistories = {};
  if (priceIndex) {
    for (let i = 0; i < priceIndex.chunks; i++) {
      const chunk = await storage.load(`price_history_${i}.json`) || {};
      Object.assign(priceHistories, chunk);
      // Free memory hint
      if (global.gc) global.gc();
    }
    console.log(`  Price histories loaded: ${Object.keys(priceHistories).length} stocks`);
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

  // ── 5. SCORE ALL (batched to stay under 512MB RAM) ──────────
  let scoringResult = null;
  try {
    const { scoreOne } = require('../scoring/masterScorer');
    const symList   = Object.keys(instruments);
    const BATCH     = 50;
    const allScores = {};
    const regime    = snap.regime || 'SIDEWAYS';
    const mktHist   = priceHistories['^NSEI'] || priceHistories['^GSPC'] || null;

    console.log(`Scoring ${symList.length} instruments in batches of ${BATCH}...`);
    let done = 0;

    for (let i = 0; i < symList.length; i += BATCH) {
      const batch = symList.slice(i, i + BATCH);
      await Promise.all(batch.map(async sym => {
        const inst    = instruments[sym];
        const history = priceHistories[sym] || [];
        try {
          allScores[sym] = await scoreOne(
            inst, snap, newsData, history, mktHist,
            regimePeriods, fundamentalsData
          );
        } catch(e) {
          allScores[sym] = { symbol:sym, score:50, signal:'HOLD',
            reason:'error', sector:inst.sector||'', country:inst.country||'IN',
            layers:{}, calibration:{}, last_price:0 };
        }
      }));
      done += batch.length;
      if (done % 100 === 0) console.log(`  Scored ${done}/${symList.length}`);
    }

    // Sort
    const sorted = Object.entries(allScores).sort(([,a],[,b]) => b.score - a.score);
    const top5   = sorted.slice(0, 5).map(([s]) => s);
    const top20  = sorted.slice(0, 20).map(([s]) => s);

    // Geo flags
    const activeFlags = {};
    Object.values(allScores).forEach(r => {
      (r.layers?.geo?.flags || []).forEach(f => {
        if (!activeFlags[f.flag]) activeFlags[f.flag] = { ...f, count:0 };
        activeFlags[f.flag].count++;
      });
    });

    scoringResult = {
      scores:      allScores,
      top5, top20,
      geo_signals: { active_flags: activeFlags },
      model:       'six-layer-v2',
      scored_at:   new Date().toISOString(),
    };

    snap.success.push(`scored:${Object.keys(allScores).length}`);
    console.log(`Scoring complete. Top 5: ${top5.join(', ')}`);
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
