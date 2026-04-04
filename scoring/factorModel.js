// ═══════════════════════════════════════════════════════════════
// FACTOR MODEL v2 — CAPM alpha/beta decomposition
// Returns FactorResult (see SCHEMA.js)
// ═══════════════════════════════════════════════════════════════
'use strict';

const { computeReturns, computeSharpe } = require('./garchEngine');
const RF_DAILY = 0.065 / 252;

function ols(y, X) {
  const n = y.length, k = X[0].length;
  const XtX = Array.from({length:k}, (_, i) => Array.from({length:k}, (_, j) =>
    X.reduce((s,row) => s + row[i]*row[j], 0)));
  const Xty = Array.from({length:k}, (_, i) => X.reduce((s,row,t) => s + row[i]*y[t], 0));
  const inv  = invertMatrix(XtX, k);
  if (!inv) return null;
  const beta   = inv.map(row => row.reduce((s,v,j) => s + v*Xty[j], 0));
  const resid  = y.map((yi,t) => yi - X[t].reduce((s,v,j) => s + v*beta[j], 0));
  const ssTot  = y.reduce((s,v) => { const d=v-y.reduce((a,b)=>a+b,0)/n; return s+d*d; }, 0);
  const ssRes  = resid.reduce((s,r) => s + r*r, 0);
  return { beta, r2:1 - ssRes/(ssTot+1e-10), residuals:resid };
}

function invertMatrix(m, n) {
  if (n===2) {
    const det = m[0][0]*m[1][1] - m[0][1]*m[1][0];
    if (Math.abs(det)<1e-10) return null;
    return [[m[1][1]/det,-m[0][1]/det],[-m[1][0]/det,m[0][0]/det]];
  }
  if (n===3) {
    const det = m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
               -m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
               +m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
    if (Math.abs(det)<1e-10) return null;
    return [
      [(m[1][1]*m[2][2]-m[1][2]*m[2][1])/det,-(m[0][1]*m[2][2]-m[0][2]*m[2][1])/det,(m[0][1]*m[1][2]-m[0][2]*m[1][1])/det],
      [-(m[1][0]*m[2][2]-m[1][2]*m[2][0])/det,(m[0][0]*m[2][2]-m[0][2]*m[2][0])/det,-(m[0][0]*m[1][2]-m[0][2]*m[1][0])/det],
      [(m[1][0]*m[2][1]-m[1][1]*m[2][0])/det,-(m[0][0]*m[2][1]-m[0][1]*m[2][0])/det,(m[0][0]*m[1][1]-m[0][1]*m[1][0])/det],
    ];
  }
  return null;
}

function compute(symbol, history, marketHistory) {
  // Always return valid schema — never crash
  const fallback = { alpha:0, beta:1, r_squared:0, information:0, momentum_12m:0, factor_score:50, source:'insufficient_data' };

  if (!history || history.length < 60) return fallback;

  try {
    const stockRets  = computeReturns(history.map(h => h.close));
    const marketRets = (marketHistory && marketHistory.length > 20)
      ? computeReturns(marketHistory.map(h => h.close))
      : stockRets.map(() => RF_DAILY * 5); // flat fallback

    const n     = Math.min(stockRets.length, marketRets.length);
    const sr    = stockRets.slice(-n).map(r => r - RF_DAILY);
    const mr    = marketRets.slice(-n).map(r => r - RF_DAILY);
    const X     = mr.map(r => [1, r]);
    const result= ols(sr, X);

    if (!result) return fallback;

    const alpha   = result.beta[0] * 252 * 100; // annualised %
    const beta    = result.beta[1];
    const r2      = result.r2;
    const infoRat = parseFloat((alpha / (Math.sqrt(result.residuals.reduce((s,r)=>s+r*r,0)/n) * Math.sqrt(252) * 100 + 1e-10)).toFixed(3));

    // Momentum 12m
    const closes  = history.map(h => h.close);
    const mom12m  = closes.length >= 252
      ? parseFloat(((closes[closes.length-1] - closes[closes.length-252]) / closes[closes.length-252] * 100).toFixed(1))
      : 0;

    // Factor score
    const alphaScore = Math.max(0, Math.min(100, 50 + alpha * 3));
    const betaScore  = Math.max(0, Math.min(100, 100 - Math.abs(beta - 0.9) * 30));
    const momScore   = Math.max(0, Math.min(100, 50 + mom12m * 1.2));
    const factorScore= Math.round(alphaScore*0.4 + betaScore*0.3 + momScore*0.3);

    return {
      alpha:        parseFloat(alpha.toFixed(2)),
      beta:         parseFloat(beta.toFixed(3)),
      r_squared:    parseFloat(r2.toFixed(3)),
      information:  infoRat,
      momentum_12m: mom12m,
      factor_score: Math.max(0, Math.min(100, factorScore)),
      source:       'calculated',
    };
  } catch(e) {
    return fallback;
  }
}

module.exports = { compute };
