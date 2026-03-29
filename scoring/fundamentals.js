// ── FUNDAMENTAL SCORING ENGINE ─────────────────────────────────
// P/E vs 5yr avg, ROE quality, debt safety, earnings quality
// Returns fundamental_score 0-100

'use strict';

// ── P/E VALUATION SCORE ───────────────────────────────────────
function scorePE(pe, pe5yrAvg, regime) {
  if (!pe || pe <= 0) return 50; // neutral if no data

  // If no historical avg, use sector defaults
  const avg = pe5yrAvg || pe * 1.1; // assume slightly overvalued if no history

  const discount = (avg - pe) / avg; // positive = trading below avg = cheap

  // Regime adjustments — in bear markets, high PE is more dangerous
  const regimeMult = {
    BULL: 0.8, SOFT_BULL: 0.9, SIDEWAYS: 1.0, SOFT_BEAR: 1.2, BEAR: 1.5
  }[regime] || 1.0;

  // Score: 0-100
  // Trading 20% below avg = 80+ score
  // Trading at avg = 50
  // Trading 20% above avg = 20 score
  const rawScore = 50 + (discount * 150 / regimeMult);
  return Math.max(0, Math.min(100, Math.round(rawScore)));
}

// ── ROE QUALITY SCORE ─────────────────────────────────────────
function scoreROE(roe) {
  if (!roe || roe === null) return 50;
  // >20% ROE = excellent (80+)
  // 15-20% = good (65-80)
  // 10-15% = average (50-65)
  // <10%   = weak (<50)
  if (roe >= 25) return 90;
  if (roe >= 20) return 80;
  if (roe >= 15) return 68;
  if (roe >= 10) return 55;
  if (roe >= 5)  return 40;
  return 25;
}

// ── DEBT SAFETY SCORE ─────────────────────────────────────────
function scoreDebtEquity(de, sector) {
  if (de === null || de === undefined) return 50;

  // Banks/NBFCs have naturally high D/E — sector-adjusted
  const isFin = sector && (sector.includes('Bank') || sector.includes('NBFC') || sector.includes('Finance'));
  const isInfra = sector && (sector.includes('Infra') || sector.includes('Power') || sector.includes('Realty'));

  let threshold;
  if (isFin)   threshold = { safe: 8, concern: 12, danger: 16 };
  else if (isInfra) threshold = { safe: 2, concern: 3.5, danger: 5 };
  else              threshold = { safe: 0.5, concern: 1.5, danger: 3 };

  if (de <= threshold.safe)    return 85;
  if (de <= threshold.concern) return 60;
  if (de <= threshold.danger)  return 35;
  return 15;
}

// ── EARNINGS REVISION SCORE ───────────────────────────────────
// Based on news sentiment about earnings
function scoreEarningsRevision(newsSignal) {
  if (!newsSignal) return 50;
  // Leverage news sentiment as earnings proxy
  const s = newsSignal.sentiment || 0;
  return Math.max(0, Math.min(100, Math.round(50 + s * 40)));
}

// ── MASTER FUNDAMENTAL SCORE ──────────────────────────────────
function computeFundamentalScore(instrument, regime, newsSignal) {
  const val     = instrument.valuation   || {};
  const cal     = instrument.calibration || {};
  const sector  = instrument.sector      || '';

  const pe      = val.pe;
  const pe5yr   = cal.pe_5yr_avg || val.pe_5yr;
  const roe     = val.roe;
  const de      = val.de;

  const peScore   = scorePE(pe, pe5yr, regime);
  const roeScore  = scoreROE(roe);
  const debtScore = scoreDebtEquity(de, sector);
  const earningsScore = scoreEarningsRevision(newsSignal);

  // If we have no fundamental data at all, return neutral
  const hasData = pe || roe || de;
  if (!hasData) {
    return {
      score:    50,
      source:   'no_data',
      components: { pe: 50, roe: 50, debt: 50, earnings: earningsScore },
    };
  }

  // Weighted combination
  const weights = {
    pe:       pe      ? 0.35 : 0,
    roe:      roe     ? 0.30 : 0,
    debt:     de !== undefined ? 0.20 : 0,
    earnings: 0.15,
  };

  // Normalize weights
  const totalW = Object.values(weights).reduce((s, w) => s + w, 0);
  if (totalW === 0) return { score: 50, source: 'no_data', components: {} };

  const score = Math.round(
    (peScore      * weights.pe       +
     roeScore     * weights.roe      +
     debtScore    * weights.debt     +
     earningsScore* weights.earnings) / totalW
  );

  return {
    score: Math.max(0, Math.min(100, score)),
    source: hasData ? 'calculated' : 'partial',
    components: {
      pe:       peScore,
      roe:      roeScore,
      debt:     debtScore,
      earnings: earningsScore,
    },
    raw: { pe, pe5yr, roe, de },
  };
}

module.exports = { computeFundamentalScore, scorePE, scoreROE, scoreDebtEquity };
