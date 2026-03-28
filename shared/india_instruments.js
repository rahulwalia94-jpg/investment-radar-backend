// ═══════════════════════════════════════════════════════════════
// india_instruments.js — India Multi-Asset Universe
// Covers: Gold/Silver ETFs, Govt Bonds, Corporate Bonds,
//         Arbitrage Funds, REITs, InvITs, Factor ETFs,
//         International ETFs, Liquid Funds
// All NSE-listed. Prices fetched via NSE API.
// ═══════════════════════════════════════════════════════════════

const INDIA_MULTI_ASSET = {

  // ── GOLD ──────────────────────────────────────────────────
  GOLDBEES:    { name:'Nippon India Gold ETF',          sector:'Gold ETF',                asset_class:'COMMODITY',         benchmark:'Gold Price',    country:'IN' },
  HDFCMFGETF:  { name:'HDFC Gold ETF',                  sector:'Gold ETF',                asset_class:'COMMODITY',         benchmark:'Gold Price',    country:'IN' },
  ICICIGOLD:   { name:'ICICI Prudential Gold ETF',       sector:'Gold ETF',                asset_class:'COMMODITY',         benchmark:'Gold Price',    country:'IN' },
  AXISGOLD:    { name:'Axis Gold ETF',                   sector:'Gold ETF',                asset_class:'COMMODITY',         benchmark:'Gold Price',    country:'IN' },
  SGBMAR29:    { name:'Sovereign Gold Bond 2029',        sector:'Sovereign Gold Bond',     asset_class:'COMMODITY',         benchmark:'Gold Price',    country:'IN', yield_pct:2.5 },

  // ── SILVER ────────────────────────────────────────────────
  SILVERBEES:  { name:'Nippon India Silver ETF',         sector:'Silver ETF',              asset_class:'COMMODITY',         benchmark:'Silver Price',  country:'IN' },
  SILVERIETF:  { name:'ICICI Prudential Silver ETF',     sector:'Silver ETF',              asset_class:'COMMODITY',         benchmark:'Silver Price',  country:'IN' },

  // ── GOVERNMENT BONDS ──────────────────────────────────────
  GILT5YBEES:  { name:'Nippon India ETF Gilt 2030',      sector:'Govt Bond ETF',           asset_class:'BOND',              duration_yrs:5,  yield_pct:7.1, credit:'SOVEREIGN', country:'IN' },
  GSEC10YEAR:  { name:'ICICI Prudential Gilt ETF',       sector:'Govt Bond ETF',           asset_class:'BOND',              duration_yrs:10, yield_pct:7.2, credit:'SOVEREIGN', country:'IN' },
  LTGILTBEES:  { name:'SBI ETF 10 Year Gilt',            sector:'Govt Bond ETF',           asset_class:'BOND',              duration_yrs:10, yield_pct:7.2, credit:'SOVEREIGN', country:'IN' },
  CPSEETF:     { name:'Bharat Bond ETF Apr 2031',        sector:'PSU Bond ETF',            asset_class:'BOND',              duration_yrs:7,  yield_pct:7.5, credit:'AAA_PSU',   country:'IN' },
  BBNPPETF:    { name:'Bharat Bond ETF Apr 2025',        sector:'PSU Bond ETF',            asset_class:'BOND',              duration_yrs:2,  yield_pct:7.3, credit:'AAA_PSU',   country:'IN' },

  // ── CORPORATE BONDS ───────────────────────────────────────
  COREBOND:    { name:'Nippon India ETF Nifty AAA Bond', sector:'Corporate Bond ETF',      asset_class:'BOND',              duration_yrs:3,  yield_pct:7.8, credit:'AAA',       country:'IN' },
  HDFCNIFETF:  { name:'HDFC NIFTY SDL Apr 2027',         sector:'SDL Bond ETF',            asset_class:'BOND',              duration_yrs:3,  yield_pct:7.6, credit:'SDL',       country:'IN' },

  // ── LIQUID / OVERNIGHT ────────────────────────────────────
  LIQUIDBEES:  { name:'Nippon India ETF Liquid BeES',    sector:'Liquid Fund ETF',         asset_class:'LIQUID',            duration_yrs:0.003, yield_pct:6.5, credit:'SOVEREIGN', country:'IN' },
  LIQLIQUID:   { name:'ICICI Prudential Liquid ETF',     sector:'Liquid Fund ETF',         asset_class:'LIQUID',            duration_yrs:0.003, yield_pct:6.5, credit:'SOVEREIGN', country:'IN' },

  // ── ARBITRAGE FUNDS ───────────────────────────────────────
  // Tax-treated as equity (LTCG 12.5% after 1yr). Returns ~7-7.5%/yr.
  // Lower risk than equity. Better than FD post-tax.
  ABSLARB:     { name:'Aditya Birla SL Arbitrage Fund',  sector:'Arbitrage Fund',          asset_class:'ARBITRAGE',         expected_return_pct:7.2, tax_treatment:'EQUITY', country:'IN' },
  HDFCARB:     { name:'HDFC Arbitrage Fund',             sector:'Arbitrage Fund',          asset_class:'ARBITRAGE',         expected_return_pct:7.1, tax_treatment:'EQUITY', country:'IN' },
  KOTAKARB:    { name:'Kotak Arbitrage Fund',            sector:'Arbitrage Fund',          asset_class:'ARBITRAGE',         expected_return_pct:7.0, tax_treatment:'EQUITY', country:'IN' },
  NIPARB:      { name:'Nippon India Arbitrage Fund',     sector:'Arbitrage Fund',          asset_class:'ARBITRAGE',         expected_return_pct:7.2, tax_treatment:'EQUITY', country:'IN' },
  ICICIARB:    { name:'ICICI Prudential Arbitrage Fund', sector:'Arbitrage Fund',          asset_class:'ARBITRAGE',         expected_return_pct:7.1, tax_treatment:'EQUITY', country:'IN' },

  // ── REITs ─────────────────────────────────────────────────
  EMBASSY:     { name:'Embassy Office Parks REIT',       sector:'Office REIT',             asset_class:'REIT',              yield_pct:6.2, noi_growth_pct:8, country:'IN' },
  MINDSPACE:   { name:'Mindspace Business Parks REIT',   sector:'Office REIT',             asset_class:'REIT',              yield_pct:6.5, noi_growth_pct:7, country:'IN' },
  BROOKFIELD:  { name:'Brookfield India REIT',           sector:'Office REIT',             asset_class:'REIT',              yield_pct:7.1, noi_growth_pct:9, country:'IN' },
  NEXUSMALLS:  { name:'Nexus Select Trust REIT',         sector:'Retail REIT',             asset_class:'REIT',              yield_pct:5.8, noi_growth_pct:10, country:'IN' },

  // ── InvITs ────────────────────────────────────────────────
  INDIGRID:    { name:'IndiGrid InvIT',                  sector:'Power Transmission InvIT',asset_class:'INVIT',             yield_pct:8.5, asset_type:'Power Grid',  country:'IN' },
  POWERGRIDINV:{ name:'PowerGrid InvIT',                 sector:'Power Transmission InvIT',asset_class:'INVIT',             yield_pct:8.2, asset_type:'Power Grid',  country:'IN', sponsor:'PGCIL' },
  NHAI:        { name:'NHAI InvIT',                      sector:'Roads InvIT',             asset_class:'INVIT',             yield_pct:8.0, asset_type:'Highways',    country:'IN', sponsor:'NHAI' },
  IRBINVIT:    { name:'IRB InvIT Fund',                  sector:'Roads InvIT',             asset_class:'INVIT',             yield_pct:8.8, asset_type:'Highways',    country:'IN' },
  STRLINFRA:   { name:'Sterlite Power InvIT',            sector:'Power Transmission InvIT',asset_class:'INVIT',             yield_pct:9.2, asset_type:'Power Grid',  country:'IN' },

  // ── DOMESTIC FACTOR ETFs ──────────────────────────────────
  NETF:        { name:'Nifty 50 ETF',                    sector:'India Broad ETF',         asset_class:'DOMESTIC_ETF',      benchmark:'Nifty 50',          country:'IN' },
  JUNIORBEES:  { name:'Nippon India ETF Junior BeES',    sector:'Midcap ETF',              asset_class:'DOMESTIC_ETF',      benchmark:'Nifty Next 50',     country:'IN' },
  MOM100:      { name:'Nifty Momentum 100 ETF',          sector:'Factor ETF',              asset_class:'DOMESTIC_ETF',      benchmark:'Nifty Momentum 100',country:'IN' },
  LOWVOL1:     { name:'ICICI Pru Nifty Low Vol 30 ETF',  sector:'Factor ETF',              asset_class:'DOMESTIC_ETF',      benchmark:'Nifty Low Vol 30',  country:'IN' },
  ALPHAETF:    { name:'Nifty Alpha 50 ETF',              sector:'Factor ETF',              asset_class:'DOMESTIC_ETF',      benchmark:'Nifty Alpha 50',    country:'IN' },
  N100:        { name:'Nifty 100 ETF',                   sector:'India Broad ETF',         asset_class:'DOMESTIC_ETF',      benchmark:'Nifty 100',         country:'IN' },

  // ── INTERNATIONAL ETFs ────────────────────────────────────
  MAFANG:      { name:'Mirae Asset NYSE FANG+ ETF',      sector:'US Tech ETF',             asset_class:'INTERNATIONAL_ETF', benchmark:'NYSE FANG+',        country:'IN' },
  MON100:      { name:'Motilal Oswal Nasdaq 100 ETF',    sector:'US Tech ETF',             asset_class:'INTERNATIONAL_ETF', benchmark:'Nasdaq 100',        country:'IN' },
  HNGSNGBEES:  { name:'Nippon India ETF Hang Seng BeES', sector:'China HK ETF',            asset_class:'INTERNATIONAL_ETF', benchmark:'Hang Seng',         country:'IN' },
};

// ── ASSET CLASS SCORING LOGIC ─────────────────────────────────
// Different asset classes need different scoring approaches

const ASSET_CLASS_REGIME_FIT = {
  // [BULL, SOFT_BULL, SIDEWAYS, SOFT_BEAR, BEAR]
  COMMODITY:         [-0.3, -0.1,  0.3,  0.7,  0.9],  // Gold/Silver: hedge in fear
  BOND:              [-0.4, -0.2,  0.2,  0.6,  0.8],  // Bonds: rate-sensitive
  LIQUID:            [-0.2, -0.1,  0.3,  0.5,  0.6],  // Liquid: always safe
  ARBITRAGE:         [ 0.0,  0.1,  0.3,  0.5,  0.5],  // Arbitrage: low vol, steady
  REIT:              [ 0.5,  0.4,  0.3,  0.0, -0.3],  // REITs: like equities but yield
  INVIT:             [ 0.4,  0.5,  0.5,  0.4,  0.3],  // InvITs: infrastructure = stable
  DOMESTIC_ETF:      [ 0.8,  0.6,  0.3, -0.1, -0.4],  // Broad market ETFs
  INTERNATIONAL_ETF: [ 0.7,  0.6,  0.4,  0.1, -0.2],  // International diversification
};

// ── BOND DURATION RISK ────────────────────────────────────────
// When RBI holds/cuts rates: long bonds rally, short bonds stable
// When RBI hikes: long bonds fall, short bonds protected
function getBondRegimeFit(durationYrs, regime, rbiStance) {
  // Current: All CBs holding — bonds neutral to slightly positive
  const durationRisk = durationYrs > 7 ? 'LONG' : durationYrs > 3 ? 'MEDIUM' : 'SHORT';
  const baseScore    = ASSET_CLASS_REGIME_FIT.BOND;
  const regIdx       = { BULL:0, SOFT_BULL:1, SIDEWAYS:2, SOFT_BEAR:3, BEAR:4 };
  const base         = baseScore[regIdx[regime] || 2];
  // Duration premium: longer = more return but more rate risk
  const durationBonus = durationRisk === 'LONG' ? 0.1 : 0;
  return Math.min(1, base + durationBonus);
}

// ── REIT / InvIT SCORING ──────────────────────────────────────
// Key metrics: distribution yield vs 10yr G-Sec, NOI growth
function getREITScore(inst, snap) {
  const yield_pct    = inst.yield_pct || 6;
  const noi_growth   = inst.noi_growth_pct || 7;
  const gsec10yr     = 7.2; // current 10yr G-Sec yield
  const spread       = yield_pct - gsec10yr; // positive = cheap vs bonds
  const spreadScore  = Math.max(-1, Math.min(1, spread / 2));
  const growthScore  = Math.max(-1, Math.min(1, (noi_growth - 7) / 5));
  return (spreadScore * 0.6 + growthScore * 0.4);
}

// ── ARBITRAGE FUND SCORING ────────────────────────────────────
// Score vs FD and liquid fund alternatives
function getArbitrageScore(inst, snap) {
  const ret  = inst.expected_return_pct || 7;
  const fd   = 7.0; // typical bank FD rate
  const liq  = 6.5; // liquid fund rate
  // Arbitrage is equity-taxed = better post-tax than FD for >1yr hold
  const preScore  = Math.max(-1, Math.min(1, (ret - fd) / 2));
  const taxBenefit = 0.3; // post-tax advantage over FD
  return preScore + taxBenefit;
}

function getAllIndiaMultiAssetSymbols() {
  return Object.keys(INDIA_MULTI_ASSET);
}

function getByAssetClass(assetClass) {
  return Object.entries(INDIA_MULTI_ASSET)
    .filter(([, v]) => v.asset_class === assetClass)
    .map(([symbol, v]) => ({ symbol, ...v }));
}

module.exports = {
  INDIA_MULTI_ASSET,
  ASSET_CLASS_REGIME_FIT,
  getBondRegimeFit,
  getREITScore,
  getArbitrageScore,
  getAllIndiaMultiAssetSymbols,
  getByAssetClass,
};
