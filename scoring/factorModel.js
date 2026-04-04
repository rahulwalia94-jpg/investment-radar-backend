// ── FAMA-FRENCH FACTOR MODEL ──────────────────────────────────
// Decomposes stock return into:
//   Alpha  — stock-specific return (skill / mispricing)
//   Beta   — market sensitivity
//   SMB    — size factor (small minus big)
//   HML    — value factor (high book/price minus low)
//   MOM    — momentum factor
//
// If alpha > 0 → stock beats market on risk-adjusted basis
'use strict';

// ── OLS REGRESSION ───────────────────────────────────────────
function ols(Y, X) {
  // Y = n×1, X = n×k (with intercept as first column)
  const n = Y.length, k = X[0].length;

  // X'X
  const XtX = Array.from({length:k}, (_, i) =>
    Array.from({length:k}, (_, j) =>
      X.reduce((s, row) => s + row[i]*row[j], 0)));

  // X'Y
  const XtY = Array.from({length:k}, (_, i) =>
    X.reduce((s, row, t) => s + row[i]*Y[t], 0));

  // Invert X'X (simple for small k)
  const n2 = k;
  const aug = XtX.map((row, i) => [...row, ...Array.from({length:n2}, (_,j)=>i===j?1:0)]);
  for (let col = 0; col < n2; col++) {
    let maxRow = col;
    for (let row = col+1; row < n2; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-12) continue;
    for (let j = 0; j < 2*n2; j++) aug[col][j] /= pivot;
    for (let row = 0; row < n2; row++) {
      if (row === col) continue;
      const f = aug[row][col];
      for (let j = 0; j < 2*n2; j++) aug[row][j] -= f*aug[col][j];
    }
  }
  const XtXinv = aug.map(row => row.slice(n2));

  // Beta = (X'X)^-1 X'Y
  const betas = XtXinv.map(row => row.reduce((s,v,j) => s+v*XtY[j], 0));

  // R-squared
  const Ymean = Y.reduce((s,v)=>s+v,0)/Y.length;
  const Ypred = X.map(row => row.reduce((s,v,j)=>s+v*betas[j],0));
  const SSres = Y.reduce((s,v,i)=>s+(v-Ypred[i])**2,0);
  const SStot = Y.reduce((s,v)=>s+(v-Ymean)**2,0);
  const r2    = SStot > 0 ? 1 - SSres/SStot : 0;

  return { betas, r2 };
}

// ── COMPUTE FACTOR RETURNS ────────────────────────────────────
function computeFactors(allInstruments, priceHistories) {
  // Market factor: use Nifty 50 for India, S&P 500 for US
  const niftyHist = priceHistories['^NSEI'] || priceHistories['NIFTY50'] || [];
  const sp500Hist = priceHistories['^GSPC'] || priceHistories['SPY']     || [];

  const mktReturns = (hist) => {
    const rets = [];
    for (let i = 1; i < hist.length; i++) {
      if (hist[i-1].close > 0) rets.push((hist[i].close - hist[i-1].close) / hist[i-1].close);
    }
    return rets;
  };

  const niftyRets = mktReturns(niftyHist);
  const sp500Rets = mktReturns(sp500Hist);

  // SMB proxy: average return of small caps minus large caps
  // Using sector ETFs as proxies
  const smallCapHist  = priceHistories['IWM'] || []; // Russell 2000
  const largeCapHist  = priceHistories['SPY'] || [];
  const smallRets     = mktReturns(smallCapHist);
  const largeRets     = mktReturns(largeCapHist);
  const smbRets       = smallRets.map((r,i) => r - (largeRets[i]||0));

  // HML proxy: value ETF minus growth ETF
  const valueHist   = priceHistories['IVE'] || [];
  const growthHist  = priceHistories['IVW'] || [];
  const valueRets   = mktReturns(valueHist);
  const growthRets  = mktReturns(growthHist);
  const hmlRets     = valueRets.map((r,i) => r - (growthRets[i]||0));

  return { niftyRets, sp500Rets, smbRets, hmlRets };
}

// ── FACTOR SCORE FOR ONE STOCK ────────────────────────────────
function computeFactorScore(sym, priceHistory, factors, isUS = false) {
  if (!priceHistory || priceHistory.length < 60) {
    return { alpha: 0, beta: 1, r2: 0, source: 'insufficient_data' };
  }

  // Stock returns
  const stockRets = [];
  for (let i = 1; i < priceHistory.length; i++) {
    if (priceHistory[i-1].close > 0) {
      stockRets.push((priceHistory[i].close - priceHistory[i-1].close) / priceHistory[i-1].close);
    }
  }

  const mktRets = isUS ? factors.sp500Rets : factors.niftyRets;

  // Align
  const minLen = Math.min(stockRets.length, mktRets.length);
  if (minLen < 30) return { alpha: 0, beta: 1, r2: 0, source: 'insufficient_data' };

  const Y = stockRets.slice(-minLen);
  const Mkt = mktRets.slice(-minLen);

  // Risk-free rate (daily)
  const rf = 0.065 / 252;

  // Excess returns
  const Ye  = Y.map(r => r - rf);
  const Mkte= Mkt.map(r => r - rf);

  // 3-factor model: Y_e = α + β_mkt × Mkt_e + β_smb × SMB + β_hml × HML + ε
  const smb = factors.smbRets.slice(-minLen);
  const hml = factors.hmlRets.slice(-minLen);

  let result;
  if (smb.length >= minLen && hml.length >= minLen) {
    const X = Mkte.map((m,i) => [1, m, smb[i]||0, hml[i]||0]);
    result = ols(Ye, X);
  } else {
    // CAPM only
    const X = Mkte.map(m => [1, m]);
    result = ols(Ye, X);
  }

  const alpha_daily  = result.betas[0] || 0;
  const beta         = result.betas[1] || 1;
  const beta_smb     = result.betas[2] || 0;
  const beta_hml     = result.betas[3] || 0;

  // Annualize alpha
  const alpha_annual = alpha_daily * 252 * 100;

  // Factor score: 0-100
  // Positive alpha = good, beta near 1 in bull = good, beta low in bear = good
  const alphaScore  = Math.max(0, Math.min(100, 50 + alpha_annual * 2));
  const betaScore   = Math.max(0, Math.min(100, 100 - Math.abs(beta - 1) * 30));

  return {
    alpha_annual:  parseFloat(alpha_annual.toFixed(2)),
    beta:          parseFloat(beta.toFixed(3)),
    beta_smb:      parseFloat(beta_smb.toFixed(3)),
    beta_hml:      parseFloat(beta_hml.toFixed(3)),
    r2:            parseFloat(result.r2.toFixed(3)),
    alpha_score:   Math.round(alphaScore),
    beta_score:    Math.round(betaScore),
    factor_score:  Math.round(alphaScore * 0.6 + betaScore * 0.4),
    source:        'calculated',
    interpretation: alpha_annual > 2 ? 'Outperforming market on risk-adjusted basis'
      : alpha_annual < -2 ? 'Underperforming market on risk-adjusted basis'
      : 'In line with market',
  };
}

// ── SCORE ALL INSTRUMENTS ────────────────────────────────────
function scoreAllFactors(instruments, priceHistories) {
  const factors = computeFactors(instruments, priceHistories);
  const results = {};

  Object.keys(instruments).forEach(sym => {
    const isUS   = instruments[sym]?.country === 'US';
    const hist   = priceHistories[sym] || [];
    results[sym] = computeFactorScore(sym, hist, factors, isUS);
  });

  return results;
}

module.exports = { computeFactorScore, scoreAllFactors, computeFactors };
