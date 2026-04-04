// ── MONTE CARLO — CORRELATED PATH SIMULATION ──────────────────
// Uses Cholesky decomposition for proper correlation structure
// Single stock: 10,000 independent paths
// Portfolio: 10,000 correlated paths via Cholesky
// All correlations from DCC model

'use strict';

const { cholesky, correlatedShocks } = require('./dccModel');

// ── SINGLE STOCK SIMULATION ───────────────────────────────────
function simulatePaths(params) {
  const {
    currentPrice, expectedReturn, sigma,
    days = 90, paths = 10000, regime,
  } = params;

  const regimeMult = {BULL:1.2,SOFT_BULL:1.1,SIDEWAYS:1.0,SOFT_BEAR:0.9,BEAR:0.8}[regime]||1.0;
  const adjRet     = expectedReturn * regimeMult;
  const dt         = 1 / 252;
  const drift      = (adjRet/100 - 0.5*sigma*sigma) * dt;
  const diffusion  = sigma * Math.sqrt(dt);

  const finals = new Float64Array(paths);
  for (let p=0;p<paths;p++) {
    let price = currentPrice;
    for (let d=0;d<days;d++) {
      const u1 = Math.random(), u2 = Math.random();
      const z  = Math.sqrt(-2*Math.log(u1+1e-10)) * Math.cos(2*Math.PI*u2);
      price   *= Math.exp(drift + diffusion*z);
    }
    finals[p] = price;
  }

  finals.sort();
  const mean    = finals.reduce((s,v)=>s+v,0)/paths;
  const winProb = finals.filter(p=>p>currentPrice).length/paths;

  return {
    paths, days,
    current_price:   parseFloat(currentPrice.toFixed(2)),
    expected_price:  parseFloat(mean.toFixed(2)),
    expected_return: parseFloat(((mean-currentPrice)/currentPrice*100).toFixed(1)),
    best_case_10:    parseFloat(finals[Math.floor(paths*0.90)].toFixed(2)),
    worst_case_10:   parseFloat(finals[Math.floor(paths*0.10)].toFixed(2)),
    p25:             parseFloat(finals[Math.floor(paths*0.25)].toFixed(2)),
    p50:             parseFloat(finals[Math.floor(paths*0.50)].toFixed(2)),
    p75:             parseFloat(finals[Math.floor(paths*0.75)].toFixed(2)),
    best_return:     parseFloat(((finals[Math.floor(paths*0.90)]-currentPrice)/currentPrice*100).toFixed(1)),
    worst_return:    parseFloat(((finals[Math.floor(paths*0.10)]-currentPrice)/currentPrice*100).toFixed(1)),
    win_probability: parseFloat((winProb*100).toFixed(1)),
    kelly_fraction:  parseFloat(Math.max(0, Math.min(0.5,
      winProb > 0.5 ? winProb - (1-winProb)/Math.max(0.1, (mean-currentPrice)/(currentPrice-finals[Math.floor(paths*0.25)]+1e-10)) : 0
    )).toFixed(3)),
    var_95:          parseFloat((currentPrice - finals[Math.floor(paths*0.05)]).toFixed(2)),
    regime,
  };
}

// ── CORRELATED PORTFOLIO SIMULATION (CHOLESKY) ────────────────
function simulatePortfolio(holdings, covMatrix, symbols, expectedReturns, days = 90, paths = 10000) {
  const n          = symbols.length;
  if (n === 0) return null;

  const dt         = 1/252;

  // Cholesky decomposition
  const L          = cholesky(covMatrix, n);

  // Pre-compute drifts and diffusions
  const drifts     = expectedReturns.map((er, i) =>
    (er/100 - 0.5 * covMatrix[i][i]) * dt
  );
  const diffusions = symbols.map((_, i) =>
    Math.sqrt(Math.max(0, covMatrix[i][i] * dt))
  );

  const totalValue    = holdings.reduce((s,h)=>s+h.value, 0);
  const weights       = holdings.map(h => h.value / totalValue);
  const finalValues   = new Float64Array(paths);

  for (let p=0;p<paths;p++) {
    // Clone portfolio values
    const values = holdings.map(h => h.value);

    for (let d=0;d<days;d++) {
      // Correlated shocks via Cholesky
      const shocks = correlatedShocks(L, n);

      // Update each position
      for (let i=0;i<n;i++) {
        const ret   = Math.exp(drifts[i] + diffusions[i] * shocks[i]);
        values[i]  *= ret;
      }
    }

    finalValues[p] = values.reduce((s,v)=>s+v, 0);
  }

  finalValues.sort();
  const mean    = finalValues.reduce((s,v)=>s+v,0)/paths;
  const winProb = finalValues.filter(v=>v>totalValue).length/paths;

  // Marginal contribution to risk per holding
  const portVariance = weights.reduce((s,wi,i) =>
    s + weights.reduce((s2,wj,j) => s2 + wi*wj*covMatrix[i][j], 0), 0
  );
  const portSigma    = Math.sqrt(portVariance * 252);
  const marginalRisk = portSigma > 0.001 ? symbols.map((sym,i) => {
    const mcr = weights.reduce((s,wj,j) => s + wj*(covMatrix[i]?.[j]||0), 0);
    return {
      symbol:        sym,
      weight:        parseFloat((weights[i]*100).toFixed(1)),
      marginal_risk: parseFloat((mcr/(portSigma+1e-10)*100).toFixed(2)),
      contribution:  parseFloat((weights[i]*mcr/(portSigma+1e-10)*100).toFixed(2)),
    };
  }) : symbols.map((sym,i) => ({
    symbol: sym,
    weight: parseFloat((weights[i]*100).toFixed(1)),
    marginal_risk: 0,
    contribution: 0,
  }));

  return {
    current_value:   parseFloat(totalValue.toFixed(2)),
    expected_value:  parseFloat(mean.toFixed(2)),
    expected_return: parseFloat(((mean-totalValue)/totalValue*100).toFixed(1)),
    best_case:       parseFloat(finalValues[Math.floor(paths*0.90)].toFixed(2)),
    worst_case:      parseFloat(finalValues[Math.floor(paths*0.10)].toFixed(2)),
    win_probability: parseFloat((winProb*100).toFixed(1)),
    var_95:          parseFloat((totalValue - finalValues[Math.floor(paths*0.05)]).toFixed(2)),
    var_99:          parseFloat((totalValue - finalValues[Math.floor(paths*0.01)]).toFixed(2)),
    portfolio_sigma: parseFloat((portSigma*100).toFixed(2)),
    marginal_risk,
    correlation_used: true,  // confirms Cholesky was used
    paths,
    days,
    symbols,
  };
}

// ── EXPAND PORTFOLIO SIMULATION TO TOP N STOCKS ──────────────
// Runs Cholesky-based simulation for portfolio + top scored stocks
function simulateExpandedPortfolio(
  portfolioHoldings,  // [{sym, qty, avgCost, currentPrice}]
  topStocks,          // [{sym, score, expReturn, sigma}] — top 20 scored
  corrMatrix,         // pre-loaded from B2 or computed
  corrSymbols,        // symbols in corrMatrix
  regime,
  usdInr = 86,
  days   = 90,
  paths  = 5000
) {
  // Combine portfolio + top stocks
  const allSyms = [...new Set([
    ...portfolioHoldings.map(h=>h.sym),
    ...topStocks.map(s=>s.sym),
  ])].filter(s => corrSymbols.includes(s));

  if (allSyms.length < 2) return null;
  const n = allSyms.length;

  // Build sub-matrix from pre-computed full matrix
  const corrFull = corrSymbols;
  const subCorr  = Array.from({length:n}, (_, i) =>
    Array.from({length:n}, (_, j) => {
      const iF = corrFull.indexOf(allSyms[i]);
      const jF = corrFull.indexOf(allSyms[j]);
      if (i===j) return 1;
      if (iF<0||jF<0) return 0;
      return corrMatrix[iF]?.[jF] || 0;
    })
  );

  // Get sigmas from topStocks or portfolio
  const sigmas = allSyms.map(sym => {
    const ts = topStocks.find(s=>s.sym===sym);
    const ph = portfolioHoldings.find(h=>h.sym===sym);
    return ts?.sigma || ph?.sigma || 0.25;
  });

  // Covariance matrix
  const cov = Array.from({length:n}, (_, i) =>
    Array.from({length:n}, (_, j) => subCorr[i][j] * sigmas[i] * sigmas[j])
  );

  // Expected returns
  const expReturns = allSyms.map(sym => {
    const ts = topStocks.find(s=>s.sym===sym);
    const ph = portfolioHoldings.find(h=>h.sym===sym);
    return ts?.expReturn || ph?.expReturn || 0;
  });

  // Holdings: portfolio gets real values, top stocks get notional 1 unit
  const holdings = allSyms.map(sym => {
    const ph = portfolioHoldings.find(h=>h.sym===sym);
    if (ph) {
      return { sym, value: ph.currentPrice * ph.qty * usdInr };
    }
    const ts = topStocks.find(s=>s.sym===sym);
    return { sym, value: ts?.price || 100 }; // notional for comparison
  });

  const result = simulatePortfolio(holdings, cov, allSyms, expReturns, days, paths);

  // Add correlation heatmap for portfolio stocks
  const portSyms = portfolioHoldings.map(h=>h.sym);
  const corrHeatmap = {};
  portSyms.forEach(a => {
    corrHeatmap[a] = {};
    portSyms.forEach(b => {
      const ia = allSyms.indexOf(a), ib = allSyms.indexOf(b);
      corrHeatmap[a][b] = ia>=0&&ib>=0 ? parseFloat((subCorr[ia][ib]).toFixed(3)) : (a===b?1:0);
    });
  });

  return result ? { ...result, correlation_heatmap: corrHeatmap } : null;
}

module.exports = { simulatePaths, simulatePortfolio, simulateExpandedPortfolio };
