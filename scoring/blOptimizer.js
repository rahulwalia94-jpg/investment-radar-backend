'use strict';

// ── BLACK-LITTERMAN PORTFOLIO OPTIMIZER ───────────────────────
// Takes: GARCH covariance + 5-layer scores as views
// Returns: Optimal portfolio weights + cash deployment advice

const { portfolioVariance } = require('./dccModel');

const RISK_AVERSION = 2.5; // Market risk aversion (standard value)
const PORTFOLIO     = { NET: true, CEG: true, GLNG: true };

// ── MARKET CAP WEIGHTS (equilibrium) ─────────────────────────
function getMarketCapWeights(symbols, metaData) {
  const caps = symbols.map(sym => {
    const meta = metaData?.[sym];
    return meta?.market_cap || 1e9; // fallback to $1B
  });
  const total = caps.reduce((s, v) => s + v, 0);
  return caps.map(c => c / total);
}

// ── IMPLIED EQUILIBRIUM RETURNS ───────────────────────────────
// π = λ × Σ × w_mkt
function impliedReturns(covMatrix, mktWeights, riskAversion = RISK_AVERSION) {
  const n = mktWeights.length;
  return Array.from({ length: n }, (_, i) =>
    riskAversion * covMatrix[i].reduce((s, v, j) => s + v * mktWeights[j], 0)
  );
}

// ── VIEWS FROM SCORES ─────────────────────────────────────────
// Convert 5-layer scores to BL views with confidence
function buildViews(symbols, scores, regime) {
  const views      = [];
  const confidences= [];

  symbols.forEach((sym, i) => {
    const s = scores[sym];
    if (!s) return;

    // View = deviation from neutral (50) mapped to return expectation
    const score = s.score || 50;
    const cal   = s.calibration || {};
    const bR    = cal.base_returns?.[regime] || 0;

    // View: expected outperformance vs market
    const view  = bR / 100; // convert % to decimal

    // Confidence: based on score extremity + data quality
    const scoreDeviation = Math.abs(score - 50) / 50; // 0 to 1
    const hasRealData    = cal.source === 'calculated' ? 1.0 : 0.5;
    const confidence     = scoreDeviation * hasRealData * 0.8; // max 80% confidence

    views.push(view);
    confidences.push(Math.max(0.1, Math.min(0.9, confidence)));
  });

  return { views, confidences };
}

// ── BLACK-LITTERMAN POSTERIOR ─────────────────────────────────
function blackLittermanPosterior(piReturns, covMatrix, views, confidences, tau = 0.05) {
  const n = piReturns.length;

  // P matrix: identity (each view is about one asset)
  // Omega: diagonal uncertainty matrix
  const omega = confidences.map(c => {
    const uncertainty = (1 - c) * tau;
    return Math.max(0.0001, uncertainty);
  });

  // BL formula (simplified for absolute views):
  // μ_BL = [(τΣ)^-1 + P'Ω^-1P]^-1 × [(τΣ)^-1π + P'Ω^-1q]
  const posteriorReturns = piReturns.map((pi, i) => {
    const tauSigma  = tau * (covMatrix[i][i] || 0.04);
    const blReturn  = (pi / tauSigma + views[i] / omega[i]) / (1 / tauSigma + 1 / omega[i]);
    return blReturn;
  });

  return posteriorReturns;
}

// ── MEAN-VARIANCE OPTIMIZATION ────────────────────────────────
function meanVarianceOptimize(expectedReturns, covMatrix, constraints = {}) {
  const n         = expectedReturns.length;
  const maxIter   = 1000;
  const { minWeight = 0, maxWeight = 0.4 } = constraints;

  // Start with equal weights
  let weights = new Array(n).fill(1 / n);

  // Gradient ascent on Sharpe ratio
  for (let iter = 0; iter < maxIter; iter++) {
    const portRet = weights.reduce((s, w, i) => s + w * expectedReturns[i], 0);
    const portVar = portfolioVariance(weights, covMatrix);
    const portStd = Math.sqrt(portVar + 1e-10);
    const sharpe  = portRet / portStd;

    // Gradient of Sharpe w.r.t. weights
    const grad = expectedReturns.map((r, i) => {
      const dRet = r;
      const dVar = 2 * covMatrix[i].reduce((s, v, j) => s + v * weights[j], 0);
      return (dRet * portStd - portRet * dVar / (2 * portStd)) / (portVar + 1e-10);
    });

    // Step
    const lr = 0.01;
    weights = weights.map((w, i) => w + lr * grad[i]);

    // Project to simplex (sum to 1, bounds)
    weights = projectToSimplex(weights, minWeight, maxWeight);
  }

  return weights;
}

function projectToSimplex(weights, minW = 0, maxW = 0.4) {
  let w = weights.map(v => Math.max(minW, Math.min(maxW, v)));
  const sum = w.reduce((s, v) => s + v, 0);
  if (sum <= 0) return new Array(w.length).fill(1 / w.length);
  return w.map(v => v / sum);
}

// ── CASH DEPLOYMENT ADVISOR ───────────────────────────────────
function adviseCashDeployment(cashAmount, symbols, optWeights, currentHoldings, scores, priceHistories, regime, usdInr = 86) {
  const advice = [];

  symbols.forEach((sym, i) => {
    const isPort     = PORTFOLIO[sym];
    const optWeight  = optWeights[i];
    const score      = scores[sym]?.score || 50;
    const signal     = scores[sym]?.signal || 'HOLD';
    const cal        = scores[sym]?.calibration || {};
    const bR         = cal.base_returns?.[regime] || 0;
    const sigma      = cal.sigma?.[regime] || 0.25;
    const hist       = priceHistories?.[sym] || [];
    const lastPrice  = hist[hist.length - 1]?.close || 0;

    if (optWeight < 0.02) return; // skip negligible weights

    const deployINR  = cashAmount * optWeight;
    const deployUSD  = deployINR / usdInr;
    const shares     = lastPrice > 0 ? (deployUSD / lastPrice).toFixed(4) : '?';

    // Current holding value
    const holding    = currentHoldings?.[sym];
    const heldValue  = holding ? holding.qty * lastPrice * usdInr : 0;

    // Kelly fraction: f = (p*b - q) / b where b = win/loss ratio
    const winProb  = bR > 0 ? Math.min(0.85, 0.5 + bR/200) : Math.max(0.15, 0.5 + bR/200);
    const winLoss  = sigma > 0 ? Math.abs(bR/100) / sigma : 1;
    const kelly    = winProb > 0.5
      ? parseFloat(Math.max(0, Math.min(0.5, (winProb*winLoss - (1-winProb)) / winLoss)).toFixed(3))
      : 0;

    advice.push({
      symbol:      sym,
      is_holding:  isPort || !!holding,
      weight:      parseFloat((optWeight * 100).toFixed(1)),
      deploy_inr:  Math.round(deployINR),
      deploy_usd:  parseFloat(deployUSD.toFixed(2)),
      shares,
      score,
      signal,
      exp_return:  bR,
      sigma:       parseFloat((sigma * 100).toFixed(1)),
      kelly_fraction: kelly,
      kelly_inr:   Math.round(cashAmount * kelly),
      reason:      scores[sym]?.reason || '',
      held_value:  Math.round(heldValue),
    });
  });

  // Sort by deploy amount
  advice.sort((a, b) => b.deploy_inr - a.deploy_inr);

  return {
    total_cash_inr: cashAmount,
    regime,
    recommendations: advice.slice(0, 10), // top 10
    generated_at: new Date().toISOString(),
  };
}

// ── MAIN BL FUNCTION ──────────────────────────────────────────
function runBlackLitterman(params) {
  const {
    symbols, covMatrix, sigmas, scores, metaData,
    priceHistories, regime, cashAmount, currentHoldings, usdInr,
  } = params;

  if (!symbols || symbols.length < 2) return null;

  try {
    // 1. Market cap weights
    const mktWeights = getMarketCapWeights(symbols, metaData);

    // 2. Implied equilibrium returns
    const piReturns  = impliedReturns(covMatrix, mktWeights);

    // 3. Views from 5-layer scores
    const { views, confidences } = buildViews(symbols, scores, regime);

    // 4. BL posterior returns
    const posteriorReturns = blackLittermanPosterior(piReturns, covMatrix, views, confidences);

    // 5. Mean-variance optimize
    const optWeights = meanVarianceOptimize(posteriorReturns, covMatrix, {
      minWeight: 0.01,
      maxWeight: 0.35,
    });

    // 6. Portfolio metrics
    const portReturn  = optWeights.reduce((s, w, i) => s + w * posteriorReturns[i], 0);
    const portVariance= portfolioVariance(optWeights, covMatrix);
    const portSharpe  = portReturn / Math.sqrt(portVariance + 1e-10);

    // 7. Cash deployment advice
    const deployment  = cashAmount
      ? adviseCashDeployment(cashAmount, symbols, optWeights, currentHoldings, scores, priceHistories, regime, usdInr)
      : null;

    return {
      optimal_weights:   symbols.reduce((obj, sym, i) => ({ ...obj, [sym]: parseFloat((optWeights[i] * 100).toFixed(1)) }), {}),
      posterior_returns: symbols.reduce((obj, sym, i) => ({ ...obj, [sym]: parseFloat((posteriorReturns[i] * 100).toFixed(2)) }), {}),
      portfolio_metrics: {
        expected_return: parseFloat((portReturn * 100).toFixed(2)),
        volatility:      parseFloat((Math.sqrt(portVariance) * 100).toFixed(2)),
        sharpe_ratio:    parseFloat(portSharpe.toFixed(3)),
      },
      cash_deployment:   deployment,
      top_pick: (()=>{
        const weights = symbols.reduce((obj,sym,i) => ({...obj,[sym]:optWeights[i]}),{});
        return Object.entries(weights).sort(([,a],[,b])=>b-a)[0]?.[0] || null;
      })(),
      regime,
      generated_at:      new Date().toISOString(),
    };
  } catch(e) {
    console.error('BL error:', e.message);
    return null;
  }
}

module.exports = { runBlackLitterman, adviseCashDeployment };
