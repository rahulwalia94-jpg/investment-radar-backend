// ═══════════════════════════════════════════════════════════════
// GARCH ENGINE v2 — Pure functions, schema-compliant
// Input:  [{date, close}], regimePeriods {date: regime}
// Output: GarchResult (see SCHEMA.js)
// ═══════════════════════════════════════════════════════════════
'use strict';

const REGIMES  = ['BULL','SOFT_BULL','SIDEWAYS','SOFT_BEAR','BEAR'];
const DEF_SIG  = { BULL:0.22, SOFT_BULL:0.26, SIDEWAYS:0.20, SOFT_BEAR:0.30, BEAR:0.38 };
const DEF_RET  = { BULL:18,   SOFT_BULL:10,   SIDEWAYS:3,    SOFT_BEAR:-5,   BEAR:-15  };
const RF_DAILY = 0.065 / 252;

function computeReturns(prices) {
  const r = [];
  for (let i = 1; i < prices.length; i++)
    if (prices[i-1] > 0) r.push((prices[i] - prices[i-1]) / prices[i-1]);
  return r;
}

function fitGARCH(returns) {
  if (!returns || returns.length < 30) return null;
  const n    = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const dem  = returns.map(r => r - mean);
  const varR = dem.reduce((s, r) => s + r * r, 0) / n;
  let omega  = varR * 0.05, alpha = 0.09, beta = 0.90;
  const h    = new Float64Array(n).fill(varR);
  for (let iter = 0; iter < 100; iter++) {
    for (let t = 1; t < n; t++) {
      h[t] = omega + alpha * dem[t-1] ** 2 + beta * h[t-1];
      if (h[t] < 1e-10) h[t] = 1e-10;
    }
    omega = Math.max(1e-9, omega + 0.001 * (varR * (1 - alpha - beta) - omega));
    if (alpha + beta >= 0.998) beta = 0.998 - alpha;
  }
  const lr = omega / Math.max(1e-10, 1 - alpha - beta);
  return { omega, alpha, beta, longRunVar:lr, annualVol:Math.sqrt(lr*252), currentVol:Math.sqrt(h[n-1]*252), h };
}

function computeRegimeStats(history, regimePeriods) {
  const sigma = { ...DEF_SIG }, baseReturns = { ...DEF_RET };
  if (!regimePeriods || Object.keys(regimePeriods).length < 50)
    return { sigma, base_returns:baseReturns, regime_matched:0 };

  const regimeRets = {};
  REGIMES.forEach(r => { regimeRets[r] = []; });
  let matched = 0;

  for (let i = 1; i < history.length; i++) {
    const r = regimePeriods[history[i].date];
    if (!r) continue;
    matched++;
    const ret = (history[i].close - history[i-1].close) / history[i-1].close;
    if (isFinite(ret)) regimeRets[r].push(ret);
  }

  REGIMES.forEach(regime => {
    const rets = regimeRets[regime];
    if (rets.length < 15) return;
    const m = rets.reduce((s, r) => s + r, 0) / rets.length;
    const v = rets.reduce((s, r) => s + (r-m)**2, 0) / rets.length;
    sigma[regime]       = parseFloat(Math.sqrt(v * 252).toFixed(4));
    baseReturns[regime] = parseFloat((m * 252 * 100).toFixed(1));
  });

  return { sigma, base_returns:baseReturns, regime_matched:matched };
}

function computeMomentum(closes) {
  const m12 = closes.length >= 252
    ? (closes[closes.length-1] - closes[closes.length-252]) / closes[closes.length-252] * 100 : 0;
  const m3  = closes.length >= 63
    ? (closes[closes.length-1] - closes[closes.length-63])  / closes[closes.length-63]  * 100 : 0;
  return { m12:parseFloat(m12.toFixed(1)), m3:parseFloat(m3.toFixed(1)) };
}

function computeSharpe(returns) {
  if (!returns || returns.length < 20) return 0;
  const n    = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const std  = Math.sqrt(returns.reduce((s, r) => s + (r-mean)**2, 0) / n);
  return std > 0 ? parseFloat(((mean - RF_DAILY) / std * Math.sqrt(252)).toFixed(3)) : 0;
}

function computeMaxDD(closes) {
  let peak = closes[0], maxDD = 0;
  closes.forEach(p => {
    if (p > peak) peak = p;
    const dd = (peak - p) / peak;
    if (dd > maxDD) maxDD = dd;
  });
  return parseFloat((maxDD * 100).toFixed(1));
}

function computeZScore(closes, window = 20) {
  if (closes.length < window) return 0;
  const slice = closes.slice(-window);
  const mean  = slice.reduce((s, v) => s + v, 0) / window;
  const std   = Math.sqrt(slice.reduce((s, v) => s + (v-mean)**2, 0) / window);
  return std > 0 ? parseFloat(((closes[closes.length-1] - mean) / std).toFixed(2)) : 0;
}

// ── MAIN: computeStock ────────────────────────────────────────
function computeStock(history, regimePeriods) {
  if (!history || history.length < 30) {
    return {
      sigma:DEF_SIG, base_returns:DEF_RET,
      sharpe:0, momentum_12m:0, momentum_3m:0,
      max_dd:0, current_vol:null, long_run_vol:null, z_score:0,
      regime_matched:0, bars:history?.length||0, source:'insufficient_data',
    };
  }
  const closes   = history.map(h => h.close);
  const returns  = computeReturns(closes);
  const garch    = fitGARCH(returns);
  const reg      = computeRegimeStats(history, regimePeriods);
  const mom      = computeMomentum(closes);
  return {
    sigma:        reg.sigma,
    base_returns: reg.base_returns,
    sharpe:       computeSharpe(returns),
    momentum_12m: mom.m12,
    momentum_3m:  mom.m3,
    max_dd:       computeMaxDD(closes),
    current_vol:  garch ? parseFloat((garch.currentVol*100).toFixed(1)) : null,
    long_run_vol: garch ? parseFloat((garch.annualVol*100).toFixed(1))  : null,
    z_score:      computeZScore(closes),
    regime_matched: reg.regime_matched,
    bars:         history.length,
    source:       garch && reg.regime_matched > 50 ? 'garch_calculated' : 'garch_partial',
    garch_alpha:  garch?.alpha,
    garch_beta:   garch?.beta,
  };
}

// ── quantScore: score 0-100 for a given regime ────────────────
function quantScore(g, regime) {
  const sig = g.sigma[regime] || 0.25;
  const exp = g.base_returns[regime] || 0;
  const sharpeScore = Math.max(0, Math.min(100, (g.sharpe + 1) / 3 * 100));
  const momScore    = Math.max(0, Math.min(100, (g.momentum_12m/100 + 0.3) / 0.6 * 100));
  const retScore    = Math.max(0, Math.min(100, (exp + 20) / 40 * 100));
  const volScore    = Math.max(0, Math.min(100, 100 - sig * 150));
  const ddScore     = Math.max(0, Math.min(100, (1 - g.max_dd/100) * 80));
  const zScore      = Math.max(0, Math.min(100, 50 - g.z_score * 10));
  const raw = sharpeScore*0.25 + momScore*0.20 + retScore*0.25 + volScore*0.15 + ddScore*0.10 + zScore*0.05;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

module.exports = { computeStock, quantScore, computeReturns, fitGARCH, computeSharpe };
