// ── MASTER SCORER v2 ──────────────────────────────────────────
// Combines all 6 models:
//   1. GARCH(1,1)          — volatility, sigma, Sharpe
//   2. News Sentiment      — FinBERT-style via Haiku
//   3. Fundamentals        — PE, ROE, D/E
//   4. Macro Signals       — FII, VIX, oil, USD/INR
//   5. Geopolitical        — Trump, Iran, RBI, OPEC
//   6. Factor Model        — alpha, beta, SMB, HML
//
// Weights: Quant 25% | News 20% | Fundamental 20% | Macro 15% | Geo 10% | Factor 10%

'use strict';

const { computeQuantScore }       = require('./garchEngine');
const { computeNewsSignal, computeGlobalGeoSignal } = require('./newsSignal');
const { computeMacroScore, getSectorMacroAdjustment } = require('./macroSignal');
const { computeFundamentalScore } = require('./fundamentals');
const { computeFactorScore, computeFactors } = require('./factorModel');
const { estimateDCC }             = require('./dccModel');

// ── REGIME-BASED SECTOR MATRIX ────────────────────────────────
const REGIME_MATRIX = {
  BEAR: {
    winners:    ['Defence','Pharma','FMCG','IT','Gold','Utilities'],
    losers:     ['Realty','NBFC','Auto','Aviation','Consumer'],
    US_winners: ['CEG','NET','PLTR','LMT','RTX','GLD','TLT','WMT','COST','JNJ','UNH'],
    US_losers:  ['TSLA','META','ARKK','SNAP','high_beta_growth'],
  },
  SOFT_BEAR: {
    winners:    ['IT','Pharma','FMCG','Defence'],
    losers:     ['Realty','NBFC','Aviation'],
    US_winners: ['MSFT','GOOGL','AAPL','NET','CEG','GLD','TLT'],
    US_losers:  ['TSLA','small_growth'],
  },
  SIDEWAYS: {
    winners:    ['IT','Banking','FMCG'],
    losers:     [],
    US_winners: [],
    US_losers:  [],
  },
  SOFT_BULL: {
    winners:    ['Banking','Auto','Realty','NBFC','Consumer'],
    losers:     ['Gold','Bonds'],
    US_winners: ['NVDA','AMD','NET','MSFT','JPM','AMZN'],
    US_losers:  ['GLD','TLT'],
  },
  BULL: {
    winners:    ['Banking','Auto','Realty','Consumer','Metals','Defence'],
    losers:     ['Gold','Bonds','defensive'],
    US_winners: ['NVDA','AMD','MSFT','AAPL','META','AMZN','TSLA'],
    US_losers:  ['GLD','TLT'],
  },
};

function getRegimeAdj(sym, sector, regime) {
  const m = REGIME_MATRIX[regime];
  if (!m) return 0;
  if (m.US_winners?.includes(sym))  return +10;
  if (m.US_losers?.includes(sym))   return -10;
  if (!sector) return 0;
  const isWinner = m.winners?.some(w => sector.includes(w));
  const isLoser  = m.losers?.some(l => sector.includes(l));
  if (isWinner) return +8;
  if (isLoser)  return -8;
  return 0;
}

function scoreToSignal(score, regime) {
  const thresholds = (regime === 'BEAR' || regime === 'SOFT_BEAR')
    ? { strong_buy:72, buy:62, hold:48, reduce:35 }
    : { strong_buy:78, buy:65, hold:50, reduce:35 };
  if (score >= thresholds.strong_buy) return 'STRONG BUY';
  if (score >= thresholds.buy)        return 'BUY';
  if (score >= thresholds.hold)       return 'HOLD';
  if (score >= thresholds.reduce)     return 'REDUCE';
  return 'AVOID';
}

function buildReason(sym, layers, regime, geoFlags) {
  const parts = [];
  const q = layers.quant?.components;
  const f = layers.factor;
  if (q?.sharpe > 1.5)      parts.push(`Sharpe ${q.sharpe.toFixed(1)}`);
  if (q?.momentum > 10)     parts.push(`+${q.momentum.toFixed(0)}% momentum`);
  if (q?.momentum < -10)    parts.push(`${q.momentum.toFixed(0)}% drawdown`);
  if (f?.alpha_annual > 3)  parts.push(`Alpha +${f.alpha_annual.toFixed(1)}%`);
  if (f?.alpha_annual < -3) parts.push(`Alpha ${f.alpha_annual.toFixed(1)}%`);
  if (geoFlags?.length > 0) {
    geoFlags.forEach(fl => {
      if (fl.impact > 5)  parts.push(`+${fl.flag.replace(/_/g,' ')}`);
      if (fl.impact < -5) parts.push(`Risk: ${fl.flag.replace(/_/g,' ')}`);
    });
  }
  const m = REGIME_MATRIX[regime];
  if (m?.US_winners?.includes(sym)) parts.push(`Defensive in ${regime}`);
  return parts.slice(0, 4).join(' · ') || `${regime} regime dynamics`;
}

// ── PRE-COMPUTE FACTORS (once per scoring run) ────────────────
let _factors = null;
let _dccResult= null;

function initModels(instruments, priceHistories) {
  _factors   = computeFactors(instruments, priceHistories);
  const syms = Object.keys(instruments).slice(0, 50); // top 50 for DCC
  _dccResult = estimateDCC(syms, priceHistories);
}

// ── MASTER SCORE ──────────────────────────────────────────────
function computeMasterScore(instrument, snap, newsData, priceHistory, regimePeriods, fundamentalsData) {
  const sym    = instrument.symbol || instrument.nse || '';
  const sector = instrument.sector || '';
  const regime = snap?.regime || 'SIDEWAYS';
  const isUS   = instrument.country === 'US';

  // ── Layer 1: QUANT (GARCH) 25% ────────────────────────────
  const history     = priceHistory || instrument._price_history || [];
  const quantResult = computeQuantScore(history, regime, regimePeriods || {});

  // ── Layer 2: NEWS 20% ─────────────────────────────────────
  const stockNews   = newsData?.stocks?.[sym]?.items || [];
  const newsResult  = computeNewsSignal(sym, sector, stockNews);

  // ── Layer 3: FUNDAMENTAL 20% ──────────────────────────────
  const fundData    = fundamentalsData?.[sym] || null;
  const instWithFund= fundData ? { ...instrument, valuation: fundData } : instrument;
  const fundResult  = computeFundamentalScore(instWithFund, regime, newsResult);

  // ── Layer 4: MACRO 15% ────────────────────────────────────
  const globalNews  = (newsData?.market || []).concat(
    Object.values(newsData?.stocks || {}).flatMap(s => s.items || []).slice(0,20));
  const newsText    = globalNews.map(n=>`${n.title} ${n.summary||''}`).join(' ');
  const macroResult = computeMacroScore(snap, newsText);
  const macroAdj    = getSectorMacroAdjustment(sector, macroResult);
  const macroScore  = Math.max(0, Math.min(100, macroResult.score + macroAdj));

  // ── Layer 5: GEO 10% ──────────────────────────────────────
  const geoFlags    = newsResult.flags || [];
  const geoScore    = Math.max(0, Math.min(100,
    50 + geoFlags.reduce((s,f) => s + (f.impact||0), 0)));

  // ── Layer 6: FACTOR MODEL 10% ────────────────────────────
  let factorResult  = { factor_score: 50, source: 'no_data' };
  if (_factors && history.length >= 60) {
    try {
      factorResult = computeFactorScore(sym, history, _factors, isUS);
    } catch(e) { /* keep default */ }
  }

  // ── REGIME ADJUSTMENT ────────────────────────────────────
  const regimeAdj = getRegimeAdj(sym, sector, regime);

  // ── WEIGHTED COMBINATION ─────────────────────────────────
  const WEIGHTS = { quant:0.30, news:0.20, fundamental:0.15, macro:0.15, geo:0.10, factor:0.10 };

  const rawScore =
    quantResult.score         * WEIGHTS.quant       +
    newsResult.score          * WEIGHTS.news        +
    fundResult.score          * WEIGHTS.fundamental +
    macroScore                * WEIGHTS.macro       +
    geoScore                  * WEIGHTS.geo         +
    factorResult.factor_score * WEIGHTS.factor;

  const finalScore = Math.max(0, Math.min(100, Math.round(rawScore + regimeAdj)));
  const signal     = scoreToSignal(finalScore, regime);

  const layers = {
    quant:       { score: quantResult.score,          weight: 25, ...quantResult },
    news:        { score: newsResult.score,            weight: 20, ...newsResult  },
    fundamental: { score: fundResult.score,            weight: 20, ...fundResult  },
    macro:       { score: macroScore,                  weight: 15, adj: macroAdj  },
    geo:         { score: geoScore,                    weight: 10, flags: geoFlags},
    factor:      { score: factorResult.factor_score,   weight: 10, ...factorResult},
  };

  // Calibration for BL / Monte Carlo
  const calibration = quantResult.calibration || {
    sigma:        { BULL:0.22, SOFT_BULL:0.26, SIDEWAYS:0.20, SOFT_BEAR:0.30, BEAR:0.42 },
    base_returns: { BULL:20,   SOFT_BULL:10,   SIDEWAYS:3,    SOFT_BEAR:-5,   BEAR:-15  },
    source:       history.length >= 60 ? 'calculated' : 'fallback',
    history_days: history.length,
  };

  return {
    symbol:      sym,
    score:       finalScore,
    signal,
    reason:      buildReason(sym, layers, regime, geoFlags),
    sector,
    country:     instrument.country || 'IN',
    layers,
    calibration,
    last_price:  instrument.last_price || 0,
    market_cap:  instrument.market_cap || fundData?.market_cap || null,
    scored_at:   new Date().toISOString(),
  };
}

// ── SCORE ALL ─────────────────────────────────────────────────
async function scoreAllInstruments(instruments, snap, newsData, priceHistories, regimePeriods, fundamentalsData) {
  const results = {};
  const symbols = Object.keys(instruments);

  console.log(`Scoring ${symbols.length} instruments with 6-layer model...`);

  // Pre-compute factors
  try { initModels(instruments, priceHistories); } catch(e) { console.log('Factor init error:', e.message); }

  let done = 0;
  for (const sym of symbols) {
    const inst    = instruments[sym];
    const history = priceHistories?.[sym] || [];
    try {
      results[sym] = computeMasterScore(inst, snap, newsData, history, regimePeriods, fundamentalsData);
    } catch(e) {
      results[sym] = {
        symbol: sym, score:50, signal:'HOLD',
        reason: 'Scoring error: ' + e.message?.slice(0,40),
        sector: inst.sector||'', layers:{}, calibration: inst.calibration||{},
        last_price: inst.last_price||0,
      };
    }
    done++;
    if (done % 50 === 0) console.log(`  Scored ${done}/${symbols.length}`);
  }

  const sorted  = Object.entries(results).sort(([,a],[,b]) => b.score - a.score);
  const top5    = sorted.slice(0,5).map(([s])=>s);
  const top20   = sorted.slice(0,20).map(([s])=>s);
  const allNews = Object.values(newsData?.stocks||{}).flatMap(s=>s.items||[]);
  const geoSigs = computeGlobalGeoSignal(allNews);

  console.log(`Scoring complete. Top 5: ${top5.join(', ')}`);

  // Build active geo flags
  const activeGeoFlags = {};
  Object.values(results).forEach(r => {
    (r.layers?.geo?.flags || []).forEach(f => {
      if (!activeGeoFlags[f.flag]) activeGeoFlags[f.flag] = { ...f, count: 0 };
      activeGeoFlags[f.flag].count++;
    });
  });

  return {
    scores:      results,
    top5, top20,
    geo_signals: { ...(geoSigs||{}), active_flags: activeGeoFlags },
    dcc:         _dccResult,
    scored_at:   new Date().toISOString(),
    model:       'six-layer-v1',
  };
}

module.exports = { computeMasterScore, scoreAllInstruments, scoreToSignal, initModels };
