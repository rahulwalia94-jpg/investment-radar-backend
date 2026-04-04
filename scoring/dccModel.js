// ═══════════════════════════════════════════════════════════════
// DCC MODEL v2 — Dynamic Conditional Correlation
// Two modes:
//   Fast:  loadFromB2(matrixData, symbols) — uses pre-computed matrix
//   Full:  buildMatrix(histories, symbols) — computes NxN (run locally)
// ═══════════════════════════════════════════════════════════════
'use strict';

const { computeReturns, fitGARCH } = require('./garchEngine');

// ── CHOLESKY ──────────────────────────────────────────────────
function cholesky(matrix, n) {
  const L = Array.from({length:n}, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
      L[i][j] = i === j
        ? Math.sqrt(Math.max(0, matrix[i][i] - sum))
        : (L[j][j] > 1e-10 ? (matrix[i][j] - sum) / L[j][j] : 0);
    }
  }
  return L;
}

// ── CORRELATED SHOCKS ─────────────────────────────────────────
function correlatedShocks(L, n) {
  const z = Array.from({length:n}, () => {
    const u1 = Math.random(), u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
  });
  return L.map(row => row.reduce((s, v, j) => s + v * z[j], 0));
}

// ── STANDARDISED RESIDUALS ────────────────────────────────────
function getResiduals(returns) {
  const garch = fitGARCH(returns);
  if (!garch) {
    const std = Math.sqrt(returns.reduce((s, r) => s + r*r, 0) / returns.length + 1e-10);
    return returns.map(r => r / std);
  }
  return returns.map((r, i) => r / Math.sqrt(Math.max(garch.h[i] || garch.longRunVar, 1e-10)));
}

// ── PAIRWISE CORRELATION ──────────────────────────────────────
function pairCorr(rA, rB) {
  const n = Math.min(rA.length, rB.length);
  if (n < 20) return 0;
  const ra = rA.slice(-n), rb = rB.slice(-n);
  const mA = ra.reduce((s,v)=>s+v,0)/n, mB = rb.reduce((s,v)=>s+v,0)/n;
  let cov=0, vA=0, vB=0;
  for (let i=0;i<n;i++) {
    const da=ra[i]-mA, db=rb[i]-mB;
    cov+=da*db; vA+=da*da; vB+=db*db;
  }
  return parseFloat(Math.max(-0.99, Math.min(0.99, cov/Math.sqrt(vA*vB+1e-10))).toFixed(4));
}

// ── BUILD FULL NxN MATRIX (run on laptop) ────────────────────
function buildMatrix(priceHistories, symbols) {
  const N = symbols.length;
  const residuals = {};
  const sigmas    = {};

  symbols.forEach(sym => {
    const hist = priceHistories[sym];
    if (!hist || hist.length < 30) { residuals[sym]=[]; sigmas[sym]=0.25; return; }
    const rets    = computeReturns(hist.map(h=>h.close));
    const garch   = fitGARCH(rets);
    sigmas[sym]   = garch ? parseFloat((garch.annualVol).toFixed(4)) : 0.25;
    residuals[sym]= getResiduals(rets);
  });

  const corr = Array.from({length:N}, (_, i) =>
    Array.from({length:N}, (_, j) => {
      if (i===j) return 1;
      if (j<i)   return corr?.[j]?.[i] || 0; // filled below
      const rA = residuals[symbols[i]], rB = residuals[symbols[j]];
      return (rA.length>=20 && rB.length>=20) ? pairCorr(rA,rB) : 0;
    })
  );

  // Fill lower triangle
  for (let i=0;i<N;i++) for (let j=0;j<i;j++) corr[i][j]=corr[j][i];

  const cov = Array.from({length:N}, (_, i) =>
    Array.from({length:N}, (_, j) => corr[i][j] * sigmas[symbols[i]] * sigmas[symbols[j]])
  );

  return { symbols, corr, cov, sigmas };
}

// ── LOAD FROM PRE-COMPUTED (fast path) ───────────────────────
function loadFromMatrix(matrixData, symbols) {
  if (!matrixData || !matrixData.symbols || !matrixData.corr) return null;

  const stored = matrixData.symbols;
  const N      = symbols.length;

  const corr = Array.from({length:N}, (_, i) =>
    Array.from({length:N}, (_, j) => {
      if (i===j) return 1;
      const si = stored.indexOf(symbols[i]);
      const sj = stored.indexOf(symbols[j]);
      return (si>=0 && sj>=0) ? (matrixData.corr[si]?.[sj] || 0) : 0;
    })
  );

  const sigmas = symbols.map(sym => matrixData.sigmas?.[sym] || 0.25);

  const cov = Array.from({length:N}, (_, i) =>
    Array.from({length:N}, (_, j) => corr[i][j] * sigmas[i] * sigmas[j])
  );

  return { symbols, corr, cov, sigmas };
}

// ── DIAGONAL FALLBACK (when no matrix available) ──────────────
function diagonalCov(symbols, sigmaMap) {
  const N      = symbols.length;
  const sigmas = symbols.map(sym => sigmaMap?.[sym] || 0.30);
  const corr   = Array.from({length:N}, (_, i) => Array.from({length:N}, (_, j) => i===j?1:0));
  const cov    = Array.from({length:N}, (_, i) => Array.from({length:N}, (_, j) => i===j ? sigmas[i]**2 : 0));
  return { symbols, corr, cov, sigmas };
}

// ── BUILD CORRELATION OBJECT for schema ───────────────────────
function buildCorrObject(symbols, corrMatrix) {
  const obj = {};
  symbols.forEach((sym, i) => {
    obj[sym] = {};
    symbols.forEach((sym2, j) => {
      obj[sym][sym2] = parseFloat((corrMatrix[i][j]).toFixed(3));
    });
  });
  return obj;
}

// ── PORTFOLIO VARIANCE ────────────────────────────────────────
function portfolioVariance(weights, cov) {
  let v = 0;
  for (let i=0;i<weights.length;i++)
    for (let j=0;j<weights.length;j++)
      v += weights[i] * weights[j] * (cov[i]?.[j]||0);
  return v;
}

module.exports = {
  buildMatrix, loadFromMatrix, diagonalCov,
  cholesky, correlatedShocks,
  buildCorrObject, portfolioVariance,
};
