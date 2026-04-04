// ── DCC MODEL — FULL CORRELATION MATRIX ───────────────────────
// Computes N×N correlation matrix using DCC(1,1)
// Cholesky decomposition for correlated Monte Carlo paths
// Designed to run on full universe (600 stocks) locally
// Daily refresh loads pre-computed matrix from B2

'use strict';

const { fitGARCH, computeReturns } = require('./garchEngine');

// ── STANDARDISED GARCH RESIDUALS ─────────────────────────────
function getResiduals(returns) {
  if (!returns || returns.length < 20) return returns || [];
  const garch = fitGARCH(returns);
  if (!garch) {
    const std = Math.sqrt(returns.reduce((s,r)=>s+r*r,0)/returns.length);
    return returns.map(r => r / (std + 1e-10));
  }
  return returns.map((r, i) => {
    const sigma = Math.sqrt(Math.max(garch.h[i] || garch.longRunVar, 1e-10));
    return r / sigma;
  });
}

// ── PAIRWISE DCC CORRELATION ──────────────────────────────────
function pairwiseDCC(rA, rB, alpha = 0.05, beta = 0.90) {
  const n = Math.min(rA.length, rB.length);
  if (n < 20) return 0;
  const ra = rA.slice(-n), rb = rB.slice(-n);
  const mA = ra.reduce((s,v)=>s+v,0)/n;
  const mB = rb.reduce((s,v)=>s+v,0)/n;
  let cov=0, vA=0, vB=0;
  for (let i=0;i<n;i++) {
    const da=ra[i]-mA, db=rb[i]-mB;
    cov+=da*db; vA+=da*da; vB+=db*db;
  }
  const rho0 = cov / Math.sqrt(vA*vB + 1e-10);
  // DCC update: q = (1-a-b)*rho0 + a*e_{t-1}*e_{t-1} + b*q_{t-1}
  const lastA = ra[n-1], lastB = rb[n-1];
  const q = (1-alpha-beta)*rho0 + alpha*lastA*lastB + beta*rho0;
  return parseFloat(Math.max(-0.99, Math.min(0.99, q)).toFixed(4));
}

// ── BUILD FULL N×N CORRELATION MATRIX ────────────────────────
// This runs on your laptop (takes minutes for 600 stocks)
function buildFullCorrelationMatrix(priceHistories, symbols) {
  const N = symbols.length;
  console.log(`Computing ${N}×${N} DCC correlation matrix (${N*(N-1)/2} pairs)...`);

  // Pre-compute residuals for all stocks
  const residuals = {};
  symbols.forEach((sym, i) => {
    const hist = priceHistories[sym];
    if (!hist || hist.length < 30) { residuals[sym] = []; return; }
    const returns = computeReturns(hist.map(h => h.close));
    residuals[sym] = getResiduals(returns);
    if (i % 50 === 0) process.stdout.write(`\r  Residuals: ${i}/${N}`);
  });
  console.log(`\n  Residuals computed for ${Object.values(residuals).filter(r=>r.length>0).length} stocks`);

  // Build correlation matrix
  const corr = Array.from({length:N}, () => new Array(N).fill(0));
  let pairs = 0;
  for (let i=0;i<N;i++) {
    corr[i][i] = 1.0;
    for (let j=i+1;j<N;j++) {
      const rA = residuals[symbols[i]];
      const rB = residuals[symbols[j]];
      const r  = (rA.length>=20 && rB.length>=20) ? pairwiseDCC(rA, rB) : 0;
      corr[i][j] = r;
      corr[j][i] = r;
      pairs++;
      if (pairs % 5000 === 0) process.stdout.write(`\r  Pairs: ${pairs}/${N*(N-1)/2}`);
    }
  }
  console.log(`\n  ✅ Matrix complete: ${N}×${N}`);
  return corr;
}

// ── BUILD COVARIANCE MATRIX from correlation + sigmas ─────────
function buildCovarianceMatrix(priceHistories, symbols, regime) {
  const N = symbols.length;

  // Get sigmas from GARCH
  const sigmas = symbols.map(sym => {
    const hist = priceHistories[sym];
    if (!hist || hist.length < 30) return 0.25;
    const returns = computeReturns(hist.map(h => h.close));
    const garch   = fitGARCH(returns);
    return garch ? Math.sqrt(garch.longRunVar * 252) : 0.25;
  });

  // Get correlation matrix
  const corr = buildFullCorrelationMatrix(priceHistories, symbols);

  // Cov[i][j] = corr[i][j] × σ[i] × σ[j]
  const cov = Array.from({length:N}, (_, i) =>
    Array.from({length:N}, (_, j) => corr[i][j] * sigmas[i] * sigmas[j])
  );

  return { cov, sigmas, corr };
}

// ── LOAD PRE-COMPUTED MATRIX FROM B2 ─────────────────────────
// Used by morning refresh (fast path)
function loadCorrelationMatrix(matrixData, symbols) {
  if (!matrixData || !matrixData.symbols || !matrixData.corr) return null;

  const storedSyms = matrixData.symbols;
  const N          = symbols.length;
  const corr       = Array.from({length:N}, () => new Array(N).fill(0));
  const sigmas     = new Array(N).fill(0.25);

  symbols.forEach((symA, i) => {
    corr[i][i] = 1.0;
    sigmas[i]  = matrixData.sigmas?.[symA] || 0.25;
    symbols.forEach((symB, j) => {
      if (i === j) return;
      const iStored = storedSyms.indexOf(symA);
      const jStored = storedSyms.indexOf(symB);
      if (iStored >= 0 && jStored >= 0) {
        corr[i][j] = matrixData.corr[iStored]?.[jStored] || 0;
      }
    });
  });

  const cov = Array.from({length:N}, (_, i) =>
    Array.from({length:N}, (_, j) => corr[i][j] * sigmas[i] * sigmas[j])
  );

  return { cov, sigmas, corr };
}

// ── CHOLESKY DECOMPOSITION ────────────────────────────────────
function cholesky(matrix, n) {
  const L = Array.from({length:n}, () => new Array(n).fill(0));
  for (let i=0;i<n;i++) {
    for (let j=0;j<=i;j++) {
      let sum = 0;
      for (let k=0;k<j;k++) sum += L[i][k] * L[j][k];
      L[i][j] = i===j
        ? Math.sqrt(Math.max(0, matrix[i][i] - sum))
        : (L[j][j] > 1e-10 ? (matrix[i][j] - sum) / L[j][j] : 0);
    }
  }
  return L;
}

// ── GENERATE CORRELATED SHOCKS ────────────────────────────────
function correlatedShocks(L, n) {
  // Generate n independent standard normals
  const z = Array.from({length:n}, () => {
    const u1 = Math.random(), u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
  });
  // Apply Cholesky: ε = L × z
  return L.map(row => row.reduce((s, v, j) => s + v * z[j], 0));
}

// ── PORTFOLIO VARIANCE ────────────────────────────────────────
function portfolioVariance(weights, covMatrix) {
  let v = 0;
  for (let i=0;i<weights.length;i++)
    for (let j=0;j<weights.length;j++)
      v += weights[i] * weights[j] * covMatrix[i][j];
  return v;
}

// ── DIVERSIFICATION RATIO ─────────────────────────────────────
function diversificationRatio(weights, sigmas, covMatrix) {
  const weightedSigma = weights.reduce((s,w,i) => s + w*sigmas[i], 0);
  const portSigma     = Math.sqrt(portfolioVariance(weights, covMatrix));
  return portSigma > 0 ? parseFloat((weightedSigma / portSigma).toFixed(3)) : 1;
}

module.exports = {
  buildFullCorrelationMatrix,
  buildCovarianceMatrix,
  loadCorrelationMatrix,
  cholesky,
  correlatedShocks,
  portfolioVariance,
  diversificationRatio,
  pairwiseDCC,
  getResiduals,
};
