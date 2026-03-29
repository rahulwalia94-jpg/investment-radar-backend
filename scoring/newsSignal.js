// ── NEWS SIGNAL ENGINE ─────────────────────────────────────────
// Reads news from B2, scores sentiment per stock
// Flags Trump/Fed/RBI/Iran/geopolitical mentions
// Returns structured signal: { score, sentiment, flags, keywords }

'use strict';

// ── SENTIMENT LEXICON ─────────────────────────────────────────
const POSITIVE = [
  'beat', 'beats', 'exceeds', 'surges', 'jumps', 'soars', 'rally', 'gain',
  'profit', 'growth', 'strong', 'record', 'upgrade', 'buy', 'bullish',
  'expansion', 'wins', 'contract', 'order', 'revenue', 'earnings beat',
  'outperforms', 'raises', 'dividend', 'buyback', 'partnership', 'launches',
  'approved', 'clearance', 'breakthrough', 'acquisition', 'merger',
];

const NEGATIVE = [
  'miss', 'misses', 'falls', 'drops', 'slumps', 'tumbles', 'crash', 'loss',
  'weak', 'cut', 'downgrade', 'sell', 'bearish', 'decline', 'warning',
  'default', 'fraud', 'probe', 'investigation', 'fine', 'penalty', 'recall',
  'delays', 'cancels', 'writedown', 'impairment', 'layoffs', 'bankruptcy',
  'concern', 'risk', 'pressure', 'headwind', 'disappoints', 'below estimate',
];

// ── GEOPOLITICAL FLAGS ────────────────────────────────────────
const GEO_FLAGS = {
  TRUMP_TARIFF: {
    keywords: ['tariff', 'trade war', 'trump tariff', 'import duty', 'trade restriction', 'section 301', 'trade deal'],
    impact:   { NET: +5, CEG: 0, GLNG: -3, 'US_Tech': -8, 'IN_IT': +5 },
    note:     'Trump tariff uncertainty — USD strengthens, EM sells off',
  },
  TRUMP_FED:    {
    keywords: ['trump fed', 'powell', 'rate cut', 'interest rate', 'fed reserve', 'monetary policy', 'trump jerome'],
    impact:   { NET: +5, CEG: +3, GLNG: 0, 'Banking': -5, 'Realty': +8 },
    note:     'Fed policy shift — rate sensitive sectors move',
  },
  IRAN_HORMUZ:  {
    keywords: ['iran', 'hormuz', 'strait of hormuz', 'persian gulf', 'middle east tension', 'oil tanker', 'lng shipping'],
    impact:   { GLNG: +15, NET: 0, CEG: +5, 'Energy': +10, 'LNG': +20 },
    note:     'Iran/Hormuz tension — LNG prices surge, shipping rates up',
  },
  RBI_POLICY:   {
    keywords: ['rbi', 'reserve bank india', 'repo rate', 'rbi policy', 'monetary policy committee', 'mpc', 'shaktikanta'],
    impact:   { 'Banking': +8, 'NBFC': +10, 'Realty': +12, 'Auto': +5 },
    note:     'RBI rate action — rate sensitives move significantly',
  },
  CHINA_SLOWDOWN: {
    keywords: ['china gdp', 'china slowdown', 'china recession', 'pmi china', 'china manufacturing'],
    impact:   { 'Metals': -10, 'Energy': -5, GLNG: -5, 'IN_IT': +3 },
    note:     'China slowdown — commodity demand falls',
  },
  INDIA_BUDGET: {
    keywords: ['union budget', 'budget 2025', 'finance minister', 'nirmala', 'fiscal deficit', 'capex budget'],
    impact:   { 'Defence': +15, 'Infra': +12, 'Realty': +8, 'Banking': +5 },
    note:     'India budget — capex allocation drives sector moves',
  },
  OPEC_OIL:     {
    keywords: ['opec', 'oil production', 'crude oil', 'brent', 'opec cut', 'opec output'],
    impact:   { 'Energy': +10, GLNG: +8, 'Aviation': -8, 'Auto': -5, 'Paints': -5 },
    note:     'OPEC oil production decision',
  },
};

// ── SCORE ARTICLE SENTIMENT ───────────────────────────────────
function scoreText(text) {
  if (!text) return 0;
  const lower  = text.toLowerCase();
  let score    = 0;
  let posCount = 0, negCount = 0;

  POSITIVE.forEach(w => { if (lower.includes(w)) posCount++; });
  NEGATIVE.forEach(w => { if (lower.includes(w)) negCount++; });

  score = (posCount - negCount) / Math.max(posCount + negCount, 1);
  return parseFloat(score.toFixed(3));
}

// ── DETECT GEOPOLITICAL FLAGS ─────────────────────────────────
function detectGeoFlags(text, symbol, sector) {
  if (!text) return [];
  const lower   = text.toLowerCase();
  const flagged = [];

  Object.entries(GEO_FLAGS).forEach(([flagName, flag]) => {
    const hit = flag.keywords.some(kw => lower.includes(kw));
    if (!hit) return;

    // Calculate impact on this specific stock/sector
    let impact = 0;
    if (flag.impact[symbol])         impact = flag.impact[symbol];
    else if (flag.impact[sector])    impact = flag.impact[sector];
    // Check sector group match
    else {
      Object.entries(flag.impact).forEach(([k, v]) => {
        if (sector && sector.includes(k)) impact = Math.max(impact, Math.abs(v)) * Math.sign(v);
      });
    }

    flagged.push({ flag: flagName, impact, note: flag.note });
  });

  return flagged;
}

// ── MAIN: COMPUTE NEWS SIGNAL PER STOCK ──────────────────────
function computeNewsSignal(symbol, sector, newsItems) {
  if (!newsItems || newsItems.length === 0) {
    return { score: 50, sentiment: 0, flags: [], keywords: [], articles: 0 };
  }

  // Only use recent news (last 7 days)
  const cutoff  = Date.now() - 7 * 24 * 3600 * 1000;
  const recent  = newsItems.filter(n => {
    const ts = n.published ? new Date(n.published).getTime() : 0;
    return ts > cutoff || !n.published; // include if no date
  });

  const items = recent.length > 0 ? recent : newsItems.slice(0, 5);

  // Score each article
  let totalSentiment = 0;
  let totalFlags     = [];
  const keywords     = new Set();

  items.forEach(item => {
    const text      = `${item.title || ''} ${item.summary || ''}`;
    const sentiment = scoreText(text);
    const flags     = detectGeoFlags(text, symbol, sector);

    totalSentiment += sentiment;
    totalFlags = totalFlags.concat(flags);

    // Extract key words
    [...POSITIVE, ...NEGATIVE].forEach(w => {
      if (text.toLowerCase().includes(w)) keywords.add(w);
    });
  });

  const avgSentiment = items.length > 0 ? totalSentiment / items.length : 0;

  // Deduplicate flags
  const uniqueFlags  = [];
  const seenFlags    = new Set();
  totalFlags.forEach(f => {
    if (!seenFlags.has(f.flag)) {
      seenFlags.add(f.flag);
      uniqueFlags.push(f);
    }
  });

  // Geo flag impact
  const geoImpact  = uniqueFlags.reduce((s, f) => s + (f.impact || 0), 0);

  // News score: 0-100
  // Base: 50 (neutral)
  // Sentiment: ±30 points
  // Geo flags: ±20 points
  const score = Math.max(0, Math.min(100,
    50 +
    avgSentiment * 30 +
    Math.max(-20, Math.min(20, geoImpact))
  ));

  return {
    score:     Math.round(score),
    sentiment: parseFloat(avgSentiment.toFixed(3)),
    flags:     uniqueFlags,
    keywords:  [...keywords].slice(0, 10),
    articles:  items.length,
    geo_impact:geoImpact,
  };
}

// ── GLOBAL NEWS SIGNAL ────────────────────────────────────────
// Detects market-wide geopolitical signals from general news
function computeGlobalGeoSignal(allNewsItems) {
  const signals = {};
  const cutoff  = Date.now() - 3 * 24 * 3600 * 1000; // last 3 days

  const recent = (allNewsItems || []).filter(n => {
    const ts = n.published ? new Date(n.published).getTime() : 0;
    return ts > cutoff || !n.published;
  });

  Object.entries(GEO_FLAGS).forEach(([flagName, flag]) => {
    const hits = recent.filter(n => {
      const text = `${n.title || ''} ${n.summary || ''}`.toLowerCase();
      return flag.keywords.some(kw => text.includes(kw));
    });

    if (hits.length > 0) {
      signals[flagName] = {
        active:  true,
        hits:    hits.length,
        impact:  flag.impact,
        note:    flag.note,
        latest:  hits[0]?.title?.slice(0, 80),
      };
    }
  });

  return signals;
}

module.exports = { computeNewsSignal, computeGlobalGeoSignal, detectGeoFlags, scoreText };
