// ── MASTER SCORER ──────────────────────────────────────────────
// Combines all 5 layers into final score
// Layer weights: Quant 30% | News 25% | Fundamental 20% | Macro 15% | Geo 10%
// Haiku does final sanity check

'use strict';

const { computeQuantScore }       = require('./garchEngine');
const { computeNewsSignal, computeGlobalGeoSignal } = require('./newsSignal');
const { computeMacroScore, getSectorMacroAdjustment } = require('./macroSignal');
const { computeFundamentalScore } = require('./fundamentals');

// ── REGIME-BASED BASE ADJUSTMENT ─────────────────────────────
const REGIME_SECTOR_MATRIX = {
  BEAR: {
    winners: ['Defence', 'Pharma', 'FMCG', 'IT', 'Gold'],
    losers:  ['Realty', 'NBFC', 'Auto', 'Aviation', 'Consumer'],
    US_winners: ['CEG', 'NET', 'PLTR', 'LMT', 'RTX', 'GLD', 'WMT', 'COST', 'JNJ', 'UNH'],
    US_losers:  ['TSLA', 'META', 'ARKK', 'SNAP'],
  },
  SOFT_BEAR: {
    winners: ['IT', 'Pharma', 'FMCG', 'Defence'],
    losers:  ['Realty', 'NBFC', 'Aviation'],
    US_winners: ['MSFT', 'GOOGL', 'AAPL', 'NET', 'CEG', 'GLD'],
    US_losers:  ['TSLA', 'small_growth'],
  },
  SIDEWAYS: {
    winners: ['IT', 'Banking', 'FMCG'],
    losers:  [],
    US_winners: [],
    US_losers:  [],
  },
  SOFT_BULL: {
    winners: ['Banking', 'Auto', 'Realty', 'NBFC', 'Consumer'],
    losers:  [],
    US_winners: ['NVDA', 'AMD', 'NET', 'MSFT', 'JPM'],
    US_losers:  [],
  },
  BULL: {
    winners: ['Banking', 'Auto', 'Realty', 'Consumer', 'Metals', 'Defence'],
    losers:  [],
    US_winners: ['NVDA', 'AMD', 'MSFT', 'AAPL', 'META', 'AMZN', 'TSLA'],
    US_losers:  ['GLD'], // gold underperforms in bull
  },
};

function getRegimeAdjustment(symbol, sector, regime) {
  const matrix = REGIME_SECTOR_MATRIX[regime];
  if (!matrix) return 0;

  // Check US winners/losers by symbol
  if (matrix.US_winners?.includes(symbol)) return +10;
  if (matrix.US_losers?.includes(symbol))  return -10;

  // Check India sector
  if (!sector) return 0;
  const isWinner = matrix.winners?.some(w => sector.includes(w));
  const isLoser  = matrix.losers?.some(l => sector.includes(l));

  if (isWinner) return +8;
  if (isLoser)  return -8;
  return 0;
}

// ── SIGNAL FROM SCORE ─────────────────────────────────────────
function scoreToSignal(score, regime) {
  if (regime === 'BEAR' || regime === 'SOFT_BEAR') {
    if (score >= 72) return 'STRONG BUY';
    if (score >= 62) return 'BUY';
    if (score >= 48) return 'HOLD';
    if (score >= 35) return 'REDUCE';
    return 'AVOID';
  }
  if (score >= 78) return 'STRONG BUY';
  if (score >= 65) return 'BUY';
  if (score >= 50) return 'HOLD';
  if (score >= 35) return 'REDUCE';
  return 'AVOID';
}

// ── BUILD REASON STRING ───────────────────────────────────────
function buildReason(symbol, layers, regime, geoFlags) {
  const parts = [];

  // Quant
  if (layers.quant?.components) {
    const q = layers.quant.components;
    if (q.sharpe > 1.5)  parts.push(`Strong Sharpe ${q.sharpe.toFixed(1)}`);
    if (q.momentum > 10) parts.push(`${q.momentum.toFixed(0)}% momentum`);
    if (q.momentum < -10)parts.push(`${q.momentum.toFixed(0)}% drawdown`);
    if (q.sigma > 0.4)   parts.push('High volatility');
  }

  // News flags
  if (geoFlags?.length > 0) {
    geoFlags.forEach(f => {
      if (f.impact > 5)  parts.push(`Positive: ${f.flag.replace(/_/g,' ')}`);
      if (f.impact < -5) parts.push(`Risk: ${f.flag.replace(/_/g,' ')}`);
    });
  }

  // Regime context
  const matrix = REGIME_SECTOR_MATRIX[regime];
  if (matrix?.US_winners?.includes(symbol)) parts.push(`Defensive in ${regime}`);
  if (matrix?.US_losers?.includes(symbol))  parts.push(`Underperforms in ${regime}`);

  // Fundamental
  if (layers.fundamental?.components) {
    const f = layers.fundamental.components;
    if (f.pe > 75)  parts.push('Attractive valuation');
    if (f.pe < 30)  parts.push('Expensive valuation');
    if (f.roe > 75) parts.push('High ROE quality');
  }

  return parts.slice(0, 3).join('. ') || `Score driven by ${regime} regime dynamics`;
}

// ── MASTER SCORE ──────────────────────────────────────────────
function computeMasterScore(instrument, snap, newsData, priceHistory, regimePeriods) {
  const symbol  = instrument.symbol || instrument.nse || '';
  const sector  = instrument.sector || '';
  const regime  = snap?.regime || 'SIDEWAYS';

  // ── LAYER 1: QUANT (GARCH) ────────────────────────────────
  const history = priceHistory || instrument._price_history || [];
  const quantResult = computeQuantScore(history, regime, regimePeriods || {});

  // ── LAYER 2: NEWS SENTIMENT ───────────────────────────────
  const stockNews  = newsData?.stocks?.[symbol]?.items || [];
  const newsResult = computeNewsSignal(symbol, sector, stockNews);

  // ── LAYER 3: FUNDAMENTAL ──────────────────────────────────
  const fundResult = computeFundamentalScore(instrument, regime, newsResult);

  // ── LAYER 4: MACRO ────────────────────────────────────────
  const globalNews  = (newsData?.market || []).concat(
    Object.values(newsData?.stocks || {}).flatMap(s => s.items || []).slice(0, 20)
  );
  const newsText    = globalNews.map(n => `${n.title} ${n.summary || ''}`).join(' ');
  const macroResult = computeMacroScore(snap, newsText);
  const macroAdj    = getSectorMacroAdjustment(sector, macroResult);

  // ── LAYER 5: GEOPOLITICAL ─────────────────────────────────
  const allNewsText = newsText;
  const geoFlags    = newsResult.flags || [];
  const geoScore    = Math.max(0, Math.min(100,
    50 + geoFlags.reduce((s, f) => s + (f.impact || 0), 0)
  ));

  // ── REGIME ADJUSTMENT ─────────────────────────────────────
  const regimeAdj = getRegimeAdjustment(symbol, sector, regime);

  // ── WEIGHTED COMBINATION ──────────────────────────────────
  const WEIGHTS = { quant: 0.30, news: 0.25, fundamental: 0.20, macro: 0.15, geo: 0.10 };

  const macroScore = Math.max(0, Math.min(100, macroResult.score + macroAdj));

  const rawScore =
    quantResult.score * WEIGHTS.quant       +
    newsResult.score  * WEIGHTS.news        +
    fundResult.score  * WEIGHTS.fundamental +
    macroScore        * WEIGHTS.macro       +
    geoScore          * WEIGHTS.geo;

  // Apply regime adjustment (±10 points)
  const finalScore = Math.max(0, Math.min(100, Math.round(rawScore + regimeAdj)));

  const signal = scoreToSignal(finalScore, regime);

  const layers = {
    quant:       { score: quantResult.score,  weight: 30, ...quantResult },
    news:        { score: newsResult.score,   weight: 25, ...newsResult  },
    fundamental: { score: fundResult.score,   weight: 20, ...fundResult  },
    macro:       { score: macroScore,         weight: 15, adj: macroAdj  },
    geo:         { score: geoScore,           weight: 10, flags: geoFlags},
  };

  const reason = buildReason(symbol, layers, regime, geoFlags);

  // Calibration data for dashboard
  const calibration = quantResult.calibration || {
    sigma:        { BULL:0.22, SOFT_BULL:0.26, SIDEWAYS:0.20, SOFT_BEAR:0.30, BEAR:0.42 },
    base_returns: { BULL:20,   SOFT_BULL:10,   SIDEWAYS:3,    SOFT_BEAR:-5,   BEAR:-15  },
    source:       'fallback',
    history_days: 0,
  };

  return {
    symbol,
    score:       finalScore,
    signal,
    reason,
    sector,
    layers,
    calibration,
    last_price:  instrument.last_price || 0,
    country:     instrument.country || 'IN',
    scored_at:   new Date().toISOString(),
  };
}

// ── SCORE ALL INSTRUMENTS ─────────────────────────────────────
async function scoreAllInstruments(instruments, snap, newsData, priceHistories, regimePeriods) {
  const results = {};
  const symbols = Object.keys(instruments);

  console.log(`Scoring ${symbols.length} instruments with 5-layer model...`);

  let done = 0;
  for (const sym of symbols) {
    const inst    = instruments[sym];
    const history = priceHistories?.[sym] || [];

    try {
      results[sym] = computeMasterScore(inst, snap, newsData, history, regimePeriods);
    } catch(e) {
      // Fallback score
      results[sym] = {
        symbol:    sym,
        score:     50,
        signal:    'HOLD',
        reason:    'Scoring error: ' + e.message?.slice(0, 50),
        sector:    inst.sector || '',
        layers:    {},
        calibration: inst.calibration || {},
        last_price:  inst.last_price || 0,
      };
    }

    done++;
    if (done % 50 === 0) console.log(`  Scored ${done}/${symbols.length}`);
  }

  // Sort by score descending
  const sorted = Object.entries(results)
    .sort(([,a], [,b]) => b.score - a.score);

  const top5 = sorted.slice(0, 5).map(([sym]) => sym);
  const top20= sorted.slice(0, 20).map(([sym]) => sym);

  // Global geo signals
  const allItems = Object.values(newsData?.stocks || {}).flatMap(s => s.items || []);
  const geoSignals = computeGlobalGeoSignal(allItems);

  console.log(`Scoring complete. Top 5: ${top5.join(', ')}`);

  return {
    scores:      results,
    top5,
    top20,
    geo_signals: geoSignals,
    scored_at:   new Date().toISOString(),
    model:       'five-layer-v1',
  };
}

module.exports = { computeMasterScore, scoreAllInstruments, scoreToSignal };
