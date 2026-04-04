// ═══════════════════════════════════════════════════════════════
// MACRO SIGNAL v2 — FII, VIX, USD/INR, Oil, Rates
// Returns MacroResult (see SCHEMA.js)
// ═══════════════════════════════════════════════════════════════
'use strict';

const SECTOR_ADJ = {
  Banking:  { fii_pos:+8,  fii_neg:-5, vix_hi:-5 },
  NBFC:     { fii_pos:+6,  fii_neg:-4, vix_hi:-4 },
  IT:       { fii_pos:+4,  fii_neg:-6, usd_strong:+6 },
  Pharma:   { fii_pos:0,   fii_neg:0,  vix_hi:0  },
  FMCG:     { fii_pos:0,   fii_neg:0,  vix_hi:+2 },
  Defence:  { fii_pos:+3,  fii_neg:0,  vix_hi:+3 },
  Realty:   { fii_pos:+10, fii_neg:-8, vix_hi:-8 },
  Auto:     { fii_pos:+5,  fii_neg:-5, vix_hi:-5 },
  Energy:   { fii_pos:+3,  fii_neg:-3, oil_up:+8 },
  Metals:   { fii_pos:+5,  fii_neg:-6, vix_hi:-6 },
};

function score(snap) {
  const fii = snap?.fii?.fii_net || 0;
  const vix = snap?.indices?.vix || 18;
  const usdInr = snap?.usdInr || 83;

  let s = 50;
  // FII flows
  if (fii > 2000) s += 12;
  else if (fii > 0) s += 5;
  else if (fii < -3000) s -= 12;
  else if (fii < 0) s -= 5;

  // VIX
  if (vix > 30) s -= 12;
  else if (vix > 22) s -= 6;
  else if (vix < 14) s += 8;
  else if (vix < 18) s += 4;

  // USD/INR (high INR weakness = bad for India)
  if (usdInr > 87) s -= 4;
  else if (usdInr < 83) s += 4;

  return {
    score:   Math.round(Math.max(0, Math.min(100, s))),
    fii_adj: fii > 0 ? Math.min(12, Math.round(fii/500)) : Math.max(-12, Math.round(fii/500)),
    vix_adj: vix > 22 ? -Math.round((vix-18)*0.5) : vix < 14 ? +8 : 0,
    usd_adj: usdInr > 87 ? -4 : usdInr < 83 ? +4 : 0,
  };
}

function sectorAdj(sector, macroResult) {
  if (!sector) return 0;
  const fiiPositive = macroResult.fii_adj > 0;
  const vixHigh     = macroResult.vix_adj < -3;
  let adj = 0;
  Object.entries(SECTOR_ADJ).forEach(([sec, rules]) => {
    if (!sector.includes(sec)) return;
    if (fiiPositive && rules.fii_pos) adj += rules.fii_pos;
    if (!fiiPositive && rules.fii_neg) adj += rules.fii_neg;
    if (vixHigh && rules.vix_hi) adj += rules.vix_hi;
  });
  return Math.max(-15, Math.min(15, adj));
}

module.exports = { score, sectorAdj };
