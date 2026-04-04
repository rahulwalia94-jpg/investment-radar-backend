// ═══════════════════════════════════════════════════════════════
// FUNDAMENTALS v2 — PE, ROE, D/E scoring
// Returns FundResult (see SCHEMA.js)
// ═══════════════════════════════════════════════════════════════
'use strict';

const SECTOR_PE = {
  IT:8, Banking:10, NBFC:12, Pharma:20, FMCG:35, Defence:25,
  Auto:15, Energy:8, Metals:8, Realty:15, Telecom:20, default:18,
};

function score(fund, sector, regime) {
  // Commodities, bonds, crypto, indices — skip fundamental scoring
  const skipSectors = ['Commodity','Bond','Crypto','Index','Currency','ETF'];
  if (!fund || skipSectors.some(s => (sector||'').startsWith(s))) {
    return { score:50, pe_score:50, roe_score:50, de_score:50, source:'not_applicable' };
  }

  const pe  = fund.pe  || fund.trailingPE || null;
  const roe = fund.roe || null;
  const de  = fund.debt_equity || fund.de || null;

  // PE score
  const sectorPE = SECTOR_PE[sector?.split(' ')[0]] || SECTOR_PE.default;
  const peScore  = pe
    ? Math.max(0, Math.min(100, pe < sectorPE*0.7 ? 85 : pe < sectorPE ? 70 : pe < sectorPE*1.3 ? 55 : pe < sectorPE*1.8 ? 40 : 25))
    : 50;

  // ROE score (higher = better, >20% is excellent)
  const roeScore = roe
    ? Math.max(0, Math.min(100, roe > 30 ? 90 : roe > 20 ? 75 : roe > 12 ? 60 : roe > 5 ? 45 : 30))
    : 50;

  // D/E score (lower = better)
  const deScore = de !== null && de !== undefined
    ? Math.max(0, Math.min(100, de < 0.3 ? 85 : de < 0.7 ? 70 : de < 1.2 ? 55 : de < 2 ? 40 : 25))
    : 50;

  // Bear regime: weight PE and D/E more (valuation and safety matter)
  const isBear = regime === 'BEAR' || regime === 'SOFT_BEAR';
  const raw    = isBear
    ? peScore * 0.40 + roeScore * 0.25 + deScore * 0.35
    : peScore * 0.35 + roeScore * 0.40 + deScore * 0.25;

  return {
    score:    Math.round(Math.max(0, Math.min(100, raw))),
    pe_score: peScore,
    roe_score: roeScore,
    de_score:  deScore,
    pe, roe, de,
    source:   'fundamentals',
  };
}

module.exports = { score };
