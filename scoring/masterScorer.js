// ═══════════════════════════════════════════════════════════════
// MASTER SCORER v2 — Orchestrates all 6 layers
// ALL async. Returns ScoringResult (see SCHEMA.js)
// Weights: quant30 news20 fund15 macro15 geo10 factor10
// ═══════════════════════════════════════════════════════════════
'use strict';

const garch    = require('./garchEngine');
const news     = require('./newsSignal');
const macro    = require('./macroSignal');
const fund     = require('./fundamentals');
const factor   = require('./factorModel');
const dcc      = require('./dccModel');
const mc       = require('./monteCarlo');
const bl       = require('./blOptimizer');

const WEIGHTS = { quant:0.30, news:0.20, fundamental:0.15, macro:0.15, geo:0.10, factor:0.10 };

const BEAR_BOOST  = new Set(['GLD','GC=F','TLT','IEF','SHY','UUP','Defence','Pharma','FMCG','Telecom','CEG']);
const BEAR_SECTOR = {
  Defence:+10, Pharma:+8, FMCG:+6, Power:+5, Telecom:+4,
  Commodity_Gold:+12,    // Gold — #1 BEAR asset
  Bond_Long:+10,         // Long bonds rally when rates fall
  Bond_Medium:+8,        // Medium bonds
  Bond_TIPS:+6,          // Inflation protection
  Commodity_Silver:+5,   // Silver follows gold
  Index_Vol:+15,         // VIX spikes in BEAR — track not trade
  Crypto:-15,            // Crypto crashes in BEAR
  Commodity_Oil:-5,      // Oil falls in recession
};
const BULL_SECTOR = {
  Banking:+8, Auto:+8, Realty:+6, Metals:+6, NBFC:+5,
  Crypto:+10,            // Crypto surges in BULL
  Commodity_Oil:+5,      // Oil rises with growth
  Bond_Long:-8,          // Bonds fall when rates rise in BULL
  Commodity_Gold:-3,     // Gold underperforms in BULL
  ETF_Tech:+8,           // Tech ETFs surge in BULL
  ETF_Semis:+10,         // Semis are cyclical BULL plays
};

function regimeAdj(symbol, sector, regime) {
  if (BEAR_BOOST.has(symbol)) return regime==='BEAR'||regime==='SOFT_BEAR' ? +12 : 0;
  const isBear = regime==='BEAR'||regime==='SOFT_BEAR';
  const isBull = regime==='BULL'||regime==='SOFT_BULL';
  const map    = isBear ? BEAR_SECTOR : isBull ? BULL_SECTOR : {};
  // Check exact sector match first, then partial
  if (map[sector]) return map[sector];
  for (const [sec, adj] of Object.entries(map)) {
    if ((sector||'').includes(sec)) return adj;
  }
  return 0;
}

function toSignal(score, regime) {
  const bear = regime==='BEAR'||regime==='SOFT_BEAR';
  if (score >= (bear?72:78)) return 'STRONG BUY';
  if (score >= (bear?62:65)) return 'BUY';
  if (score >= (bear?48:50)) return 'HOLD';
  if (score >= 35)           return 'REDUCE';
  return 'AVOID';
}

// ── SCORE ONE INSTRUMENT (async) ──────────────────────────────
async function scoreOne(instrument, snap, newsData, history, marketHistory, regimePeriods, fundamentalsData) {
  const sym    = instrument.symbol || instrument.nse || '';
  const sector = instrument.sector || '';
  const regime = snap?.regime || 'SIDEWAYS';

  // Layer 1: GARCH (sync)
  const garchResult = garch.computeStock(history || [], regimePeriods || {});
  const quantSc     = garch.quantScore(garchResult, regime);

  // Layer 2: News (async — MUST await)
  const stockItems  = newsData?.stocks?.[sym]?.items || [];
  const newsResult  = await news.score(sym, sector, stockItems);

  // Layer 3: Fundamentals (sync)
  const fundData    = fundamentalsData?.[sym] || instrument.fundamentals || null;
  const fundResult  = fund.score(fundData, sector, regime);

  // Layer 4: Macro (sync)
  const macroResult = macro.score(snap);
  const macroAdj    = macro.sectorAdj(sector, macroResult);
  const macroScore  = Math.max(0, Math.min(100, macroResult.score + macroAdj));

  // Layer 5: Geo (from news flags)
  const geoFlags    = newsResult.flags || [];
  const geoScore    = Math.max(0, Math.min(100, 50 + geoFlags.reduce((s, f) => s + (f.impact||0), 0)));

  // Layer 6: Factor (sync, never crashes)
  const factorResult= factor.compute(sym, history || [], marketHistory || null);

  // Weighted score — all values guaranteed numbers
  const raw =
    quantSc              * WEIGHTS.quant       +
    newsResult.score     * WEIGHTS.news        +
    fundResult.score     * WEIGHTS.fundamental +
    macroScore           * WEIGHTS.macro       +
    geoScore             * WEIGHTS.geo         +
    factorResult.factor_score * WEIGHTS.factor;

  const adj        = regimeAdj(sym, sector, regime);
  const finalScore = Math.round(Math.max(0, Math.min(100, raw + adj)));

  // Validate — should never be NaN
  if (isNaN(finalScore)) {
    console.error(`NaN score for ${sym}: quant=${quantSc} news=${newsResult.score} fund=${fundResult.score} macro=${macroScore} geo=${geoScore} factor=${factorResult.factor_score}`);
    return { symbol:sym, score:50, signal:'HOLD', reason:'scoring error', sector, country:instrument.country||'IN',
      layers:{}, calibration:garchResult, last_price:instrument.last_price||0 };
  }

  const layers = {
    quant:       { score:quantSc,              weight:30, ...garchResult, source:garchResult.source },
    news:        { score:newsResult.score,     weight:20, ...newsResult },
    fundamental: { score:fundResult.score,     weight:15, ...fundResult },
    macro:       { score:macroScore,           weight:15, ...macroResult, sector_adj:macroAdj },
    geo:         { score:geoScore,             weight:10, flags:geoFlags },
    factor:      { score:factorResult.factor_score, weight:10, ...factorResult },
  };

  const reason = [
    garchResult.sharpe > 1.0 && `Sharpe ${garchResult.sharpe.toFixed(1)}`,
    garchResult.momentum_12m > 10 && `Mom ${garchResult.momentum_12m.toFixed(0)}%`,
    geoFlags.length > 0 && geoFlags.map(f => f.flag.replace(/_/g,' ')).join(', '),
    factorResult.alpha > 2 && `Alpha ${factorResult.alpha.toFixed(1)}%/yr`,
  ].filter(Boolean).slice(0, 2).join('. ') || `${regime} regime`;

  return {
    symbol:     sym,
    score:      finalScore,
    signal:     toSignal(finalScore, regime),
    reason,
    sector,
    country:    instrument.country || 'IN',
    last_price: instrument.last_price || history?.[history.length-1]?.close || 0,
    layers,
    calibration: garchResult,  // also at top level for legacy compat
    scored_at:  new Date().toISOString(),
  };
}

// ── SCORE ALL INSTRUMENTS ─────────────────────────────────────
async function scoreAll(instruments, snap, newsData, priceHistories, regimePeriods, fundamentalsData, corrMatrixData) {
  const symbols = Object.keys(instruments);
  const regime  = snap?.regime || 'SIDEWAYS';
  const results = {};

  // Market history for factor model
  const marketHistory = priceHistories?.['^NSEI'] || priceHistories?.['^GSPC'] || priceHistories?.['SPY'] || null;

  console.log(`Scoring ${symbols.length} instruments | regime: ${regime} | regimePeriods: ${Object.keys(regimePeriods||{}).length}`);

  // Spot check regime matching
  if (symbols.length > 0 && priceHistories) {
    const s0   = symbols[0];
    const h0   = priceHistories[s0] || [];
    const hits = h0.filter(b => regimePeriods?.[b.date]).length;
    console.log(`  Regime check ${s0}: ${hits}/${h0.length} bars tagged`);
  }

  // Score all instruments (sequential to avoid memory spikes)
  let done = 0;
  for (const sym of symbols) {
    const inst    = instruments[sym];
    const history = priceHistories?.[sym] || [];
    try {
      results[sym] = await scoreOne(inst, snap, newsData, history, marketHistory, regimePeriods, fundamentalsData);
    } catch(e) {
      console.error(`Score error ${sym}:`, e.message);
      results[sym] = { symbol:sym, score:50, signal:'HOLD', reason:`error: ${e.message.slice(0,30)}`,
        sector:inst.sector||'', country:inst.country||'IN', layers:{}, calibration:{}, last_price:0 };
    }
    done++;
    if (done % 100 === 0) console.log(`  Scored ${done}/${symbols.length}`);
  }

  // Sort
  const sorted = Object.entries(results).sort(([,a],[,b]) => b.score - a.score);
  const top5   = sorted.slice(0, 5).map(([s]) => s);
  const top20  = sorted.slice(0, 20).map(([s]) => s);

  // DCC — use pre-computed matrix or compute for top20
  let dccResult = null;
  try {
    const portSyms = ['NET','CEG','GLNG'].filter(s => priceHistories?.[s]?.length >= 30);
    const dccSyms  = [...new Set([...portSyms, ...top20.slice(0,15)])].filter(s => priceHistories?.[s]?.length >= 30);

    let covData = null;
    if (corrMatrixData?.symbols?.length > 0) {
      covData = dcc.loadFromMatrix(corrMatrixData, dccSyms);
    }
    if (!covData) {
      const sigmaMap = dccSyms.reduce((o, s) => ({ ...o, [s]: results[s]?.calibration?.sigma?.[regime] || 0.25 }), {});
      covData = dcc.diagonalCov(dccSyms, sigmaMap);
    }

    dccResult = {
      symbols:     dccSyms,
      correlation: dcc.buildCorrObject(dccSyms, covData.corr),
      covariance:  covData.cov,
      sigmas:      dccSyms.reduce((o, s, i) => ({ ...o, [s]: parseFloat((covData.sigmas[i]*100).toFixed(1)) }), {}),
      source:      corrMatrixData?.symbols?.length > 0 ? 'precomputed' : 'diagonal',
      regime,
    };

    const portCorr = portSyms.map(a => portSyms.map(b => parseFloat((dccResult.correlation[a]?.[b]||0).toFixed(3))));
    console.log('DCC:', portSyms.map((a,i) => portSyms.slice(i+1).map(b => `${a}-${b}: ${dccResult.correlation[a]?.[b]?.toFixed(3)}`)).flat().join(' | '));
  } catch(e) {
    console.error('DCC error:', e.message);
  }

  // Monte Carlo — always runs (uses DCC if available, diagonal if not)
  let mcResults = {};
  try {
    const PORTFOLIO = [
      { sym:'NET',  qty:1.066992, avgCost:208.62 },
      { sym:'CEG',  qty:0.714253, avgCost:310.43 },
      { sym:'GLNG', qty:3.489692, avgCost:50.93  },
    ];
    const usdInr = snap?.usdInr || 86;

    for (const h of PORTFOLIO) {
      const hist     = priceHistories?.[h.sym] || [];
      const cal      = results[h.sym]?.calibration || {};
      const lastPrice= hist[hist.length-1]?.close || snap?.usPrices?.[h.sym] || h.avgCost;
      const sigma    = cal.sigma?.[regime] || 0.30;
      const expRet   = cal.base_returns?.[regime] || 0;

      mcResults[h.sym] = {
        ...mc.simulatePaths({ currentPrice:lastPrice, expectedReturn:expRet, sigma, days:90, paths:10000, regime }),
        avg_cost:    h.avgCost,
        qty:         h.qty,
        current_inr: Math.round(lastPrice * h.qty * usdInr),
        pl_pct:      parseFloat(((lastPrice - h.avgCost) / h.avgCost * 100).toFixed(1)),
      };
    }

    // Portfolio Cholesky
    if (dccResult) {
      const portSyms   = PORTFOLIO.map(h => h.sym).filter(s => dccResult.symbols.includes(s));
      const portHoldings = PORTFOLIO.filter(h => portSyms.includes(h.sym)).map(h => {
        const hist  = priceHistories?.[h.sym] || [];
        const price = hist[hist.length-1]?.close || h.avgCost;
        return { sym:h.sym, value:price * h.qty * usdInr };
      });
      const portIdx = portSyms.map(s => dccResult.symbols.indexOf(s));
      const subCov  = portIdx.map(i => portIdx.map(j => dccResult.covariance?.[i]?.[j] || 0));
      const expRets = portSyms.map(s => results[s]?.calibration?.base_returns?.[regime] || 0);

      mcResults._portfolio = {
        ...mc.simulatePortfolio(portHoldings, subCov, portSyms, expRets, 90, 10000),
        cholesky_used: true,
        usdInr,
      };
    }

    console.log(`Monte Carlo: NET=${mcResults.NET?.win_probability}% CEG=${mcResults.CEG?.win_probability}% GLNG=${mcResults.GLNG?.win_probability}%`);
  } catch(e) {
    console.error('MC error:', e.message);
  }

  // Black-Litterman
  let blResult = null;
  try {
    if (dccResult && top20.length >= 5) {
      const blSyms = top20.filter(s => dccResult.symbols.includes(s)).slice(0, 15);
      const blIdx  = blSyms.map(s => dccResult.symbols.indexOf(s));
      const blCov  = blIdx.map(i => blIdx.map(j => dccResult.covariance?.[i]?.[j] || 0));

      blResult = bl.run({
        symbols:     blSyms,
        covMatrix:   blCov,
        scores:      results,
        priceHistories,
        regime,
        holdings:    [{ sym:'NET' }, { sym:'CEG' }, { sym:'GLNG' }],
      });
      if (blResult) console.log(`BL: top_pick=${blResult.top_pick} sharpe=${blResult.portfolio_metrics?.sharpe_ratio}`);
    }
  } catch(e) {
    console.error('BL error:', e.message);
  }

  // Geo flags summary
  const activeFlags = {};
  Object.values(results).forEach(r => {
    (r.layers?.geo?.flags || []).forEach(f => {
      if (!activeFlags[f.flag]) activeFlags[f.flag] = { ...f, count:0 };
      activeFlags[f.flag].count++;
    });
  });

  // News stats
  const newsCount   = Object.values(results).filter(r => (r.layers?.news?.articles||0) > 0).length;
  const finbertCount= Object.values(results).filter(r => r.layers?.news?.source === 'finbert').length;
  console.log(`News: ${newsCount} stocks scored | FinBERT: ${finbertCount}`);

  console.log(`Scoring complete. Top 5: ${top5.join(', ')}`);

  return {
    scores:      results,
    top5, top20,
    geo_signals: { active_flags: activeFlags },
    dcc:         dccResult,
    monte_carlo: mcResults,
    bl_result:   blResult,
    model:       'six-layer-v2',
    scored_at:   new Date().toISOString(),
  };
}

module.exports = { scoreAll, scoreOne };
