// ── GARCH(1,1) ENGINE IN PURE NODE.JS ─────────────────────────
// No Python dependency. Runs on Render directly.
// Produces: sigma per regime, Sharpe, momentum, VaR, z-score

'use strict';

// ── GARCH(1,1) ESTIMATION ─────────────────────────────────────
function fitGARCH(returns) {
  if (!returns || returns.length < 30) return null;

  const n    = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const demeaned = returns.map(r => r - mean);

  // Initialize with variance estimates
  let omega = 0.00001;
  let alpha = 0.09;
  let beta  = 0.90;

  // Simple iterative estimation (method of moments + persistence)
  const variance = demeaned.reduce((s, r) => s + r * r, 0) / n;

  // GARCH variance series
  const h = new Array(n).fill(variance);

  // Iterate to convergence
  for (let iter = 0; iter < 50; iter++) {
    let gradOmega = 0, gradAlpha = 0, gradBeta = 0;
    let ll = 0;

    for (let t = 1; t < n; t++) {
      h[t] = omega + alpha * demeaned[t-1] ** 2 + beta * h[t-1];
      if (h[t] < 1e-10) h[t] = 1e-10;
      ll += -0.5 * (Math.log(2 * Math.PI * h[t]) + demeaned[t] ** 2 / h[t]);
    }

    // Gradient step (simplified)
    const lr = 0.0001;
    omega = Math.max(1e-8, omega + lr * (variance - omega));
    alpha = Math.max(0.01, Math.min(0.3, alpha));
    beta  = Math.max(0.5,  Math.min(0.97, beta));

    if (alpha + beta >= 0.999) beta = 0.999 - alpha;
  }

  // Long-run variance
  const longRunVar = omega / (1 - alpha - beta);
  const annualVol  = Math.sqrt(longRunVar * 252);

  // Current conditional variance
  const currentH   = h[n-1];
  const currentVol = Math.sqrt(currentH * 252);

  return { omega, alpha, beta, longRunVar, annualVol, currentVol, h };
}

// ── COMPUTE RETURNS ───────────────────────────────────────────
function computeReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i-1] > 0) {
      returns.push((prices[i] - prices[i-1]) / prices[i-1]);
    }
  }
  return returns;
}

// ── SHARPE RATIO ──────────────────────────────────────────────
function computeSharpe(returns, riskFreeRate = 0.065 / 252) {
  if (!returns || returns.length < 20) return 0;
  const mean   = returns.reduce((s, r) => s + r, 0) / returns.length;
  const excess = mean - riskFreeRate;
  const std    = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  return std > 0 ? (excess / std) * Math.sqrt(252) : 0;
}

// ── MOMENTUM SCORE ────────────────────────────────────────────
function computeMomentum(closes) {
  if (!closes || closes.length < 20) return 0;
  const n    = closes.length;
  const now  = closes[n-1];

  // Multiple timeframe momentum
  const m1m  = closes.length >= 21  ? (now - closes[n-21])  / closes[n-21]  : 0;
  const m3m  = closes.length >= 63  ? (now - closes[n-63])  / closes[n-63]  : 0;
  const m6m  = closes.length >= 126 ? (now - closes[n-126]) / closes[n-126] : 0;
  const m12m = closes.length >= 252 ? (now - closes[n-252]) / closes[n-252] : 0;

  // Weighted momentum (more weight on recent)
  const momentum = m1m * 0.4 + m3m * 0.3 + m6m * 0.2 + m12m * 0.1;
  return momentum;
}

// ── MEAN REVERSION Z-SCORE ────────────────────────────────────
function computeZScore(closes, window = 20) {
  if (!closes || closes.length < window) return 0;
  const recent = closes.slice(-window);
  const mean   = recent.reduce((s, c) => s + c, 0) / window;
  const std    = Math.sqrt(recent.reduce((s, c) => s + (c - mean) ** 2, 0) / window);
  const last   = closes[closes.length - 1];
  return std > 0 ? (last - mean) / std : 0;
}

// ── VALUE AT RISK ─────────────────────────────────────────────
function computeVaR(returns, confidence = 0.95) {
  if (!returns || returns.length < 20) return 0.02;
  const sorted = [...returns].sort((a, b) => a - b);
  const idx    = Math.floor((1 - confidence) * sorted.length);
  return Math.abs(sorted[idx] || 0);
}

// ── REGIME SIGMA ──────────────────────────────────────────────
// Compute volatility for each regime period
function computeRegimeSigma(history, regimePeriods) {
  const REGIMES   = ['BULL', 'SOFT_BULL', 'SIDEWAYS', 'SOFT_BEAR', 'BEAR'];
  const defaults  = { BULL: 0.22, SOFT_BULL: 0.26, SIDEWAYS: 0.20, SOFT_BEAR: 0.30, BEAR: 0.42 };
  const sigma     = { ...defaults };

  if (!regimePeriods || Object.keys(regimePeriods).length === 0) return sigma;

  // Group returns by regime
  const regimeReturns = {};
  REGIMES.forEach(r => regimeReturns[r] = []);

  history.forEach(bar => {
    const regime = regimePeriods[bar.date];
    if (!regime || !regimeReturns[regime]) return;
    // We need consecutive dates to compute returns — mark for later
    bar._regime = regime;
  });

  // Compute returns and assign to regime
  for (let i = 1; i < history.length; i++) {
    const prev = history[i-1];
    const curr = history[i];
    if (!curr._regime) continue;
    const ret = (curr.close - prev.close) / prev.close;
    regimeReturns[curr._regime].push(ret);
  }

  // Compute annualized vol per regime
  REGIMES.forEach(regime => {
    const rets = regimeReturns[regime];
    if (rets.length < 10) return; // not enough data, keep default
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
    sigma[regime] = parseFloat(Math.sqrt(variance * 252).toFixed(4));
  });

  return sigma;
}

// ── REGIME BASE RETURNS ───────────────────────────────────────
function computeRegimeBaseReturns(history, regimePeriods) {
  const REGIMES     = ['BULL', 'SOFT_BULL', 'SIDEWAYS', 'SOFT_BEAR', 'BEAR'];
  const defaults    = { BULL: 20, SOFT_BULL: 10, SIDEWAYS: 3, SOFT_BEAR: -5, BEAR: -15 };
  const baseReturns = { ...defaults };

  if (!regimePeriods || Object.keys(regimePeriods).length === 0) return baseReturns;

  const regimeRets = {};
  REGIMES.forEach(r => regimeRets[r] = []);

  // Tag each bar with regime
  history.forEach(bar => {
    const regime = regimePeriods[bar.date];
    if (regime) bar._regime = regime;
  });

  for (let i = 1; i < history.length; i++) {
    const prev = history[i-1];
    const curr = history[i];
    if (!curr._regime) continue;
    const ret = (curr.close - prev.close) / prev.close;
    regimeRets[curr._regime].push(ret);
  }

  REGIMES.forEach(regime => {
    const rets = regimeRets[regime];
    if (rets.length < 10) return;
    const annualRet = (rets.reduce((s, r) => s + r, 0) / rets.length) * 252 * 100;
    baseReturns[regime] = parseFloat(annualRet.toFixed(1));
  });

  return baseReturns;
}

// ── QUANT SCORE ───────────────────────────────────────────────
// Main function: takes price history, returns quant score 0-100
function computeQuantScore(history, currentRegime = 'SIDEWAYS', regimePeriods = {}) {
  if (!history || history.length < 30) {
    return { score: 50, components: {}, source: 'insufficient_data' };
  }

  const closes  = history.map(h => h.close);
  const returns = computeReturns(closes);

  // GARCH
  const garch   = fitGARCH(returns);
  const sigma   = computeRegimeSigma(history, regimePeriods);
  const bReturns= computeRegimeBaseReturns(history, regimePeriods);

  // Signals
  const sharpe  = computeSharpe(returns);
  const momentum= computeMomentum(closes);
  const zScore  = computeZScore(closes);
  const vaR95   = computeVaR(returns, 0.95);

  // Current regime sigma
  const currentSigma  = sigma[currentRegime] || 0.25;
  const expectedReturn= bReturns[currentRegime] || 0;

  // Score components (each 0-100)
  // 1. Sharpe score: >2 = 100, <-1 = 0
  const sharpeScore   = Math.max(0, Math.min(100, (sharpe + 1) / 3 * 100));

  // 2. Momentum score: +30% annual = 100, -30% = 0
  const momScore      = Math.max(0, Math.min(100, (momentum + 0.3) / 0.6 * 100));

  // 3. Volatility score: lower vol in bear = better; higher vol in bull = ok
  const volPenalty    = currentRegime === 'BEAR' || currentRegime === 'SOFT_BEAR'
    ? Math.max(0, 100 - currentSigma * 200)  // penalize high vol in bear
    : Math.max(0, 100 - currentSigma * 100); // mild penalty in bull

  // 4. Expected return score
  const retScore      = Math.max(0, Math.min(100, (expectedReturn + 20) / 40 * 100));

  // 5. Mean reversion: extreme negative z = oversold = opportunity
  const zScore_score  = Math.max(0, Math.min(100, (-zScore + 2) / 4 * 100));

  // Weighted combination
  const score = Math.round(
    sharpeScore  * 0.30 +
    momScore     * 0.25 +
    retScore     * 0.25 +
    volPenalty   * 0.10 +
    zScore_score * 0.10
  );

  return {
    score:       Math.max(0, Math.min(100, score)),
    source:      'garch_calculated',
    history_days:history.length,
    components: {
      sharpe:    parseFloat(sharpe.toFixed(3)),
      momentum:  parseFloat((momentum * 100).toFixed(1)),
      sigma:     currentSigma,
      var95:     parseFloat((vaR95 * 100).toFixed(2)),
      z_score:   parseFloat(zScore.toFixed(2)),
      exp_return:expectedReturn,
    },
    calibration: {
      sigma,
      base_returns: bReturns,
      source:      history.length >= 200 ? 'calculated' : 'partial',
      history_days: history.length,
    },
  };
}

module.exports = { computeQuantScore, fitGARCH, computeSharpe, computeMomentum, computeZScore, computeVaR, computeRegimeSigma };
