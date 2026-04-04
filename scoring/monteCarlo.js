// ═══════════════════════════════════════════════════════════════
// MONTE CARLO v2 — Cholesky-correlated simulation
// simulatePaths: single stock (independent)
// simulatePortfolio: multi-stock (Cholesky correlated)
// ═══════════════════════════════════════════════════════════════
'use strict';

const { cholesky, correlatedShocks, portfolioVariance } = require('./dccModel');

// ── SINGLE STOCK ──────────────────────────────────────────────
function simulatePaths({ currentPrice, expectedReturn, sigma, days=90, paths=10000, regime }) {
  if (!currentPrice || currentPrice <= 0) return null;

  const regAdj = { BULL:1.2, SOFT_BULL:1.1, SIDEWAYS:1.0, SOFT_BEAR:0.9, BEAR:0.8 }[regime] || 1.0;
  const adjRet = (expectedReturn || 0) * regAdj;
  const dt     = 1 / 252;
  const drift  = (adjRet/100 - 0.5 * sigma**2) * dt;
  const diff   = sigma * Math.sqrt(dt);

  const finals = new Float64Array(paths);
  for (let p = 0; p < paths; p++) {
    let price = currentPrice;
    for (let d = 0; d < days; d++) {
      const u1 = Math.random(), u2 = Math.random();
      const z  = Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
      price   *= Math.exp(drift + diff * z);
    }
    finals[p] = price;
  }

  finals.sort();
  const mean    = finals.reduce((s, v) => s + v, 0) / paths;
  const winProb = finals.filter(p => p > currentPrice).length / paths;
  const p25 = finals[Math.floor(paths*0.25)];
  const p75 = finals[Math.floor(paths*0.75)];
  const winLoss = (p75 - currentPrice) / Math.max(0.01, currentPrice - p25);
  const kelly   = winProb > 0.5
    ? Math.max(0, Math.min(0.5, (winProb*winLoss - (1-winProb)) / winLoss))
    : 0;

  return {
    paths, days,
    current_price:   parseFloat(currentPrice.toFixed(2)),
    expected_price:  parseFloat(mean.toFixed(2)),
    expected_return: parseFloat(((mean - currentPrice) / currentPrice * 100).toFixed(1)),
    best_case_10:    parseFloat(finals[Math.floor(paths*0.90)].toFixed(2)),
    worst_case_10:   parseFloat(finals[Math.floor(paths*0.10)].toFixed(2)),
    best_return:     parseFloat(((finals[Math.floor(paths*0.90)] - currentPrice) / currentPrice * 100).toFixed(1)),
    worst_return:    parseFloat(((finals[Math.floor(paths*0.10)] - currentPrice) / currentPrice * 100).toFixed(1)),
    p25:             parseFloat(p25.toFixed(2)),
    p50:             parseFloat(finals[Math.floor(paths*0.50)].toFixed(2)),
    p75:             parseFloat(p75.toFixed(2)),
    win_probability: parseFloat((winProb * 100).toFixed(1)),
    kelly_fraction:  parseFloat(kelly.toFixed(3)),
    var_95:          parseFloat((currentPrice - finals[Math.floor(paths*0.05)]).toFixed(2)),
    regime,
  };
}

// ── PORTFOLIO (Cholesky correlated) ───────────────────────────
function simulatePortfolio(holdings, covMatrix, symbols, expectedReturns, days=90, paths=10000) {
  const n          = symbols.length;
  if (n === 0 || !holdings || holdings.length === 0) return null;

  const totalValue = holdings.reduce((s, h) => s + h.value, 0);
  if (totalValue <= 0) return null;

  const weights = holdings.map(h => h.value / totalValue);
  const dt      = 1 / 252;

  // Drifts and diffusions per stock
  const drifts = expectedReturns.map((er, i) =>
    ((er || 0)/100 - 0.5 * (covMatrix[i]?.[i] || 0.09)) * dt
  );
  const diffs = symbols.map((_, i) =>
    Math.sqrt(Math.max(0, (covMatrix[i]?.[i] || 0.09) * dt))
  );

  // Cholesky
  const L = cholesky(covMatrix, n);

  const finals = new Float64Array(paths);
  for (let p = 0; p < paths; p++) {
    const vals = holdings.map(h => h.value);
    for (let d = 0; d < days; d++) {
      const shocks = correlatedShocks(L, n);
      for (let i = 0; i < n; i++) {
        vals[i] *= Math.exp(drifts[i] + diffs[i] * shocks[i]);
      }
    }
    finals[p] = vals.reduce((s, v) => s + v, 0);
  }

  finals.sort();
  const mean    = finals.reduce((s, v) => s + v, 0) / paths;
  const winProb = finals.filter(v => v > totalValue).length / paths;

  // Portfolio sigma (annualised)
  const portVariance = portfolioVariance(weights, covMatrix);
  const portSigma    = Math.sqrt(portVariance); // cov already annualised

  // Marginal risk contribution
  const marginal_risk = symbols.map((sym, i) => {
    const mcr = weights.reduce((s, wj, j) => s + wj * (covMatrix[i]?.[j] || 0), 0);
    return {
      symbol:        sym,
      weight:        parseFloat((weights[i] * 100).toFixed(1)),
      marginal_risk: portSigma > 0.001 ? parseFloat((mcr / portSigma * 100).toFixed(2)) : 0,
      contribution:  portSigma > 0.001 ? parseFloat((weights[i] * mcr / portSigma * 100).toFixed(2)) : 0,
    };
  });

  return {
    current_value:    parseFloat(totalValue.toFixed(2)),
    expected_value:   parseFloat(mean.toFixed(2)),
    expected_return:  parseFloat(((mean - totalValue) / totalValue * 100).toFixed(1)),
    best_case:        parseFloat(finals[Math.floor(paths*0.90)].toFixed(2)),
    worst_case:       parseFloat(finals[Math.floor(paths*0.10)].toFixed(2)),
    win_probability:  parseFloat((winProb * 100).toFixed(1)),
    var_95:           parseFloat((totalValue - finals[Math.floor(paths*0.05)]).toFixed(2)),
    var_99:           parseFloat((totalValue - finals[Math.floor(paths*0.01)]).toFixed(2)),
    portfolio_sigma:  parseFloat((portSigma * 100).toFixed(2)),
    correlation_used: true,
    marginal_risk,
    paths, days, symbols,
  };
}

module.exports = { simulatePaths, simulatePortfolio };
