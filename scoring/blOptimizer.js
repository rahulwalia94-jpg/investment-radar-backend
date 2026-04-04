// ═══════════════════════════════════════════════════════════════
// BLACK-LITTERMAN v2 — Portfolio optimizer
// Input: scores, DCC covariance, holdings
// Output: BLResult (see SCHEMA.js)
// ═══════════════════════════════════════════════════════════════
'use strict';

const { portfolioVariance } = require('./dccModel');
const LAMBDA = 2.5; // risk aversion

function impliedReturns(cov, weights) {
  return weights.map((_, i) =>
    LAMBDA * cov[i].reduce((s, v, j) => s + v * weights[j], 0)
  );
}

function blPosterior(pi, views, confidences, cov, tau = 0.05) {
  return pi.map((p, i) => {
    const tauSig = tau * (cov[i][i] || 0.04);
    const omega  = Math.max(0.0001, (1 - confidences[i]) * tau);
    return (p / tauSig + views[i] / omega) / (1 / tauSig + 1 / omega);
  });
}

function projectToSimplex(w, minW = 0.01, maxW = 0.25) {
  const clipped = w.map(v => Math.max(minW, Math.min(maxW, v)));
  const sum     = clipped.reduce((s, v) => s + v, 0);
  return sum > 0 ? clipped.map(v => v / sum) : clipped.map(() => 1 / clipped.length);
}

function optimize(expReturns, cov, iterations = 500) {
  const n = expReturns.length;
  let weights = new Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const portRet = weights.reduce((s, w, i) => s + w * expReturns[i], 0);
    const portVar = portfolioVariance(weights, cov);
    const portStd = Math.sqrt(portVar + 1e-10);
    const grad    = expReturns.map((r, i) => {
      const dVar = 2 * cov[i].reduce((s, v, j) => s + v * weights[j], 0);
      return (r * portStd - portRet * dVar / (2 * portStd)) / (portVar + 1e-10);
    });
    weights = projectToSimplex(weights.map((w, i) => w + 0.01 * grad[i]));
  }
  return weights;
}

function run(params) {
  const { symbols, covMatrix, scores, priceHistories, regime, holdings, usdInr = 86 } = params;
  if (!symbols || symbols.length < 3 || !covMatrix) return null;

  try {
    const n    = symbols.length;
    const mkt  = new Array(n).fill(1 / n); // equal market weights fallback
    const pi   = impliedReturns(covMatrix, mkt);

    // Views from scores
    const views       = symbols.map(sym => (scores[sym]?.calibration?.base_returns?.[regime] || 0) / 100);
    const confidences = symbols.map(sym => {
      const s = scores[sym]?.score || 50;
      return Math.max(0.1, Math.min(0.8, Math.abs(s - 50) / 50 * 0.8));
    });

    const posterior = blPosterior(pi, views, confidences, covMatrix);
    const optWeights= optimize(posterior, covMatrix);
    const portRet   = optWeights.reduce((s, w, i) => s + w * posterior[i], 0);
    const portVar   = portfolioVariance(optWeights, covMatrix);
    const sharpe    = portRet / Math.sqrt(portVar + 1e-10);

    // Top pick
    const topIdx    = optWeights.indexOf(Math.max(...optWeights));
    const top_pick  = symbols[topIdx];

    // Recommendations
    const portSyms  = new Set((holdings||[]).map(h => h.sym));
    const recs      = symbols
      .map((sym, i) => {
        const w       = optWeights[i];
        const cal     = scores[sym]?.calibration || {};
        const expRet  = cal.base_returns?.[regime] || 0;
        const sigma   = cal.sigma?.[regime] || 0.30;
        const winProb = expRet > 0 ? Math.min(0.85, 0.5 + expRet/200) : Math.max(0.15, 0.5 + expRet/200);
        const winLoss = sigma > 0 ? Math.abs(expRet/100) / sigma : 1;
        const kelly   = winProb > 0.5
          ? parseFloat(Math.max(0, Math.min(0.5, (winProb*winLoss - (1-winProb)) / winLoss)).toFixed(3))
          : 0;
        return {
          symbol:      sym,
          weight:      parseFloat((w * 100).toFixed(1)),
          exp_return:  expRet,
          sigma:       parseFloat((sigma * 100).toFixed(1)),
          score:       scores[sym]?.score || 50,
          signal:      scores[sym]?.signal || 'HOLD',
          is_holding:  portSyms.has(sym),
          kelly_fraction: kelly,
        };
      })
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10);

    return {
      optimal_weights:   symbols.reduce((o, sym, i) => ({ ...o, [sym]: parseFloat((optWeights[i]*100).toFixed(1)) }), {}),
      posterior_returns: symbols.reduce((o, sym, i) => ({ ...o, [sym]: parseFloat((posterior[i]*100).toFixed(2)) }), {}),
      portfolio_metrics: {
        expected_return: parseFloat((portRet * 100).toFixed(2)),
        volatility:      parseFloat((Math.sqrt(portVar) * 100).toFixed(2)),
        sharpe_ratio:    parseFloat(sharpe.toFixed(3)),
      },
      top_pick,
      regime,
      recommendations: recs,
      generated_at: new Date().toISOString(),
    };
  } catch(e) {
    console.log('BL error:', e.message);
    return null;
  }
}

module.exports = { run };
