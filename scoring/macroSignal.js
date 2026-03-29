// ── MACRO SIGNAL ENGINE ────────────────────────────────────────
// FII flow, VIX, DXY, oil, central bank stance
// Returns macro_score per regime and sector impact

'use strict';

// ── FII SIGNAL ────────────────────────────────────────────────
function computeFIISignal(fiiNetCr, regime) {
  // fiiNetCr: net FII flow in Crores (negative = selling)
  const signal = {};

  // Intensity buckets
  if (fiiNetCr >= 5000)       signal.label = 'HEAVY_BUYING';
  else if (fiiNetCr >= 1000)  signal.label = 'BUYING';
  else if (fiiNetCr >= -1000) signal.label = 'NEUTRAL';
  else if (fiiNetCr >= -5000) signal.label = 'SELLING';
  else                        signal.label = 'HEAVY_SELLING';

  // Score: -30 to +30 contribution
  signal.score     = Math.max(-30, Math.min(30, fiiNetCr / 500));
  signal.value     = fiiNetCr;
  signal.direction = fiiNetCr >= 0 ? 'BUY' : 'SELL';

  // Sector-specific FII impact
  // FII typically goes into large-caps: Banking, IT, Consumer
  signal.sector_impact = {
    Banking:   fiiNetCr >= 0 ? +8  : -8,
    IT:        fiiNetCr >= 0 ? +6  : -6,
    FMCG:      fiiNetCr >= 0 ? +4  : -3,
    Energy:    fiiNetCr >= 0 ? +3  : -3,
    Metals:    fiiNetCr >= 0 ? +5  : -5,
    Realty:    fiiNetCr >= 0 ? +4  : -4,
    Defence:   0, // FII-insensitive (govt sector)
    Pharma:    fiiNetCr >= 0 ? +3  : -2,
  };

  return signal;
}

// ── VIX SIGNAL ────────────────────────────────────────────────
function computeVIXSignal(vix, prevVix) {
  const signal = {};

  // Absolute level
  if (vix > 30)       signal.level = 'EXTREME_FEAR';
  else if (vix > 22)  signal.level = 'HIGH_FEAR';
  else if (vix > 16)  signal.level = 'ELEVATED';
  else if (vix > 12)  signal.level = 'CALM';
  else                signal.level = 'COMPLACENT';

  // Trend (if prev available)
  if (prevVix) {
    const change       = vix - prevVix;
    signal.trend       = change > 1.5 ? 'RISING' : change < -1.5 ? 'FALLING' : 'STABLE';
    signal.trend_value = parseFloat(change.toFixed(1));
  }

  // Score contribution: high VIX = bearish (-20 to 0)
  signal.score = Math.max(-20, Math.min(0, -(vix - 15) * 1.5));

  // High VIX = opportunity for REVERSAL stocks (mean reversion)
  signal.reversal_opportunity = vix > 25;

  return signal;
}

// ── OIL SIGNAL ────────────────────────────────────────────────
function computeOilSignal(brentPrice) {
  const signal = {};

  if (brentPrice > 100)      signal.level = 'VERY_HIGH';
  else if (brentPrice > 85)  signal.level = 'HIGH';
  else if (brentPrice > 70)  signal.level = 'MODERATE';
  else if (brentPrice > 55)  signal.level = 'LOW';
  else                       signal.level = 'VERY_LOW';

  signal.value = brentPrice;

  // Sector impact
  signal.sector_impact = {
    Energy:   brentPrice > 80 ? +15 : brentPrice > 60 ? +5 : -5,
    LNG:      brentPrice > 80 ? +12 : +5,   // LNG prices correlated
    Aviation: brentPrice > 80 ? -12 : brentPrice > 70 ? -6 : +5,
    Auto:     brentPrice > 80 ? -6  : +2,
    Paints:   brentPrice > 80 ? -8  : +2,
    Chemicals:brentPrice > 80 ? -5  : +2,
    FMCG:     brentPrice > 90 ? -4  : 0,
  };

  // Score: high oil is net negative for India (net importer)
  signal.score = brentPrice > 90 ? -10 : brentPrice > 80 ? -5 : brentPrice < 65 ? +5 : 0;

  return signal;
}

// ── USD/INR SIGNAL ────────────────────────────────────────────
function computeUSDINRSignal(usdInr) {
  const signal = {};

  // Baseline: ~84 Rs/USD as of 2025
  const baseline = 84;
  const deviation = ((usdInr - baseline) / baseline) * 100;

  if (deviation > 3)        signal.level = 'INR_WEAK';
  else if (deviation > 1)   signal.level = 'INR_SOFT';
  else if (deviation > -1)  signal.level = 'INR_STABLE';
  else                      signal.level = 'INR_STRONG';

  signal.value    = usdInr;
  signal.deviation= parseFloat(deviation.toFixed(1));

  // Sector impact: weak INR = good for exporters, bad for importers
  const isWeakINR = deviation > 1;
  signal.sector_impact = {
    IT:        isWeakINR ? +8  : -5,    // IT is USD earner
    Pharma:    isWeakINR ? +6  : -3,    // Pharma exports USD
    Energy:    isWeakINR ? -5  : +3,    // Oil imports in USD
    Auto:      isWeakINR ? -4  : +2,    // Component imports
    FMCG:      isWeakINR ? -2  : +1,
  };

  // Score: weak INR mixed — net slight negative for market
  signal.score = isWeakINR ? -3 : deviation < -1 ? +3 : 0;

  return signal;
}

// ── CENTRAL BANK STANCE ───────────────────────────────────────
function detectCBStance(newsText) {
  if (!newsText) return { rbi: 'NEUTRAL', fed: 'NEUTRAL' };

  const lower = newsText.toLowerCase();

  // RBI
  let rbi = 'NEUTRAL';
  const rbiDovish  = ['rate cut', 'rbi cut', 'accommodation', 'liquidity', 'growth focus', 'easing'];
  const rbiHawkish = ['rate hike', 'rbi hike', 'inflation concern', 'tightening', 'withdrawal'];
  if (rbiDovish.some(w => lower.includes(w)))  rbi = 'DOVISH';
  if (rbiHawkish.some(w => lower.includes(w))) rbi = 'HAWKISH';

  // Fed
  let fed = 'NEUTRAL';
  const fedDovish  = ['fed cut', 'rate cut', 'fed pivot', 'dovish', 'lower rates', 'pause'];
  const fedHawkish = ['fed hike', 'higher for longer', 'hawkish', 'inflation fight', 'tighten'];
  if (fedDovish.some(w => lower.includes(w)))  fed = 'DOVISH';
  if (fedHawkish.some(w => lower.includes(w))) fed = 'HAWKISH';

  return { rbi, fed };
}

// ── MASTER MACRO SCORE ────────────────────────────────────────
function computeMacroScore(snap, newsText) {
  const fii    = snap?.fii?.fii_net      || 0;
  const vix    = snap?.indices?.['INDIA VIX']?.last || 17;
  const brent  = snap?.brent             || 85;
  const usdInr = snap?.usdInr            || 84;
  const regime = snap?.regime            || 'SIDEWAYS';

  const fiiSig  = computeFIISignal(fii, regime);
  const vixSig  = computeVIXSignal(vix);
  const oilSig  = computeOilSignal(brent);
  const fxSig   = computeUSDINRSignal(usdInr);
  const cbStance= detectCBStance(newsText);

  // CB score
  let cbScore = 0;
  if (cbStance.rbi === 'DOVISH') cbScore += 8;
  if (cbStance.rbi === 'HAWKISH') cbScore -= 8;
  if (cbStance.fed === 'DOVISH') cbScore += 5;
  if (cbStance.fed === 'HAWKISH') cbScore -= 5;

  // Total macro score: base 50 + components
  const totalScore = Math.max(0, Math.min(100,
    50 +
    fiiSig.score +
    vixSig.score +
    oilSig.score +
    fxSig.score  +
    cbScore
  ));

  return {
    score:    Math.round(totalScore),
    fii:      fiiSig,
    vix:      vixSig,
    oil:      oilSig,
    fx:       fxSig,
    cb:       cbStance,
    regime,
    components: {
      fii_score: parseFloat(fiiSig.score.toFixed(1)),
      vix_score: parseFloat(vixSig.score.toFixed(1)),
      oil_score: oilSig.score,
      fx_score:  fxSig.score,
      cb_score:  cbScore,
    },
  };
}

// ── SECTOR MACRO ADJUSTMENT ───────────────────────────────────
// Given macro signals, how much to adjust a specific sector's score
function getSectorMacroAdjustment(sector, macroResult) {
  let adjustment = 0;

  // FII impact
  const fiiImpact = macroResult.fii?.sector_impact?.[sector];
  if (fiiImpact) adjustment += fiiImpact * 0.3; // 30% weight on FII

  // Oil impact
  const oilImpact = macroResult.oil?.sector_impact?.[sector];
  if (oilImpact) adjustment += oilImpact * 0.3;

  // FX impact
  const fxImpact  = macroResult.fx?.sector_impact?.[sector];
  if (fxImpact)  adjustment += fxImpact * 0.2;

  return parseFloat(adjustment.toFixed(1));
}

module.exports = {
  computeMacroScore, computeFIISignal, computeVIXSignal,
  computeOilSignal, computeUSDINRSignal, detectCBStance,
  getSectorMacroAdjustment,
};
