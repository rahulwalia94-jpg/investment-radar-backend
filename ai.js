// ═══════════════════════════════════════════════════════════════
// AI Engine — Phase 3
// ALL Claude calls use Haiku — cheap, fast, good enough
// Reads calibration from Firebase — no hardcoded returns
// ═══════════════════════════════════════════════════════════════
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── HAIKU (all tasks) ─────────────────────────────────────────
async function callHaiku(prompt, maxTokens = 1000) {
  try {
    const res = await client.messages.create({
      model:      'claude-haiku-4-5-20251001', // $0.80/M input $4/M output
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }],
    });
    return res.content[0]?.text || null;
  } catch (e) {
    console.error('Haiku error:', e.message);
    return null;
  }
}

function parseJSON(text) {
  if (!text) return null;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch (e) {}
  return null;
}

// ── 1. SCORE ALL INSTRUMENTS (reads from Firebase) ────────────
// This is the core — no hardcoded base returns
// Reads calibrated data from Firebase and scores dynamically
async function scoreAllInstruments(snapshot, instruments) {
  const regime  = snapshot.regime || 'SIDEWAYS';
  const fii     = snapshot.fii?.fii_net || 0;
  const vix     = snapshot.indices?.['INDIA VIX']?.last || 17.8;
  const brent   = snapshot.brent  || 90;
  const usdInr  = snapshot.usdInr || 86;

  // ── REGIME CONTEXT (same for all sector prompts) ──────────
  const regimeContext = `
MARKET CONDITIONS:
- Regime: ${regime} | FII: ${Math.round(fii)} Cr (${fii < -3000 ? 'HEAVY SELLING' : fii < 0 ? 'selling' : fii > 3000 ? 'HEAVY BUYING' : 'buying'})
- VIX: ${vix} (${vix > 22 ? 'HIGH FEAR' : vix > 16 ? 'elevated' : 'calm'}) | Oil: $${brent} | USD/INR: ${usdInr}
- All 4 major CBs holding rates — tight global liquidity
- Iran war active — oil supply risk, LNG disruption, Hormuz restricted
- User holds NET (Cloudflare), CEG (nuclear power), GLNG (LNG — Iran direct play)

REGIME SCORING GUIDE for ${regime}:
- DEFENSIVE sectors score higher: pharma, FMCG, gold, IT exporters (USD earners)
- AVOID in this regime: rate-sensitives, real estate, consumer discretionary, aviation
- FII ${fii < 0 ? 'SELLING — momentum is negative for beta stocks' : 'BUYING — momentum supports quality growth'}
- Oil $${brent}: ${brent > 95 ? 'HIGH — good for energy/defence, BAD for aviation/auto/paints' : 'MODERATE — neutral impact'}
- USD/INR ${usdInr}: good for IT exporters, pharma exporters, gold ETFs`;

  // ── GROUP INSTRUMENTS BY SECTOR ───────────────────────────
  // Score each sector independently — no cross-sector positional bias
  const SECTOR_GROUPS = {
    'Defence':    ['HAL','BEL','COCHINSHIP','GRSE','MTARTECH','PARASDEF','BHARATFORG','BHEL','MIDHANI','DRAFTFCM'],
    'IT':         ['TCS','INFY','HCLTECH','WIPRO','PERSISTENT','LTIM','COFORGE','MPHASIS','KPITTECH','CYIENT'],
    'Banking':    ['ICICIBANK','HDFCBANK','SBIN','AXISBANK','KOTAKBANK','INDUSINDBK','BANKBARODA','FEDERALBNK'],
    'NBFC':       ['BAJFINANCE','BAJAJFINSV','SHRIRAMFIN','CHOLAFIN','MUTHOOTFIN','MANAPPURAM'],
    'Energy':     ['ONGC','RELIANCE','COALINDIA','GAIL','IOC','BPCL','HINDPETRO','MRPL'],
    'Pharma':     ['SUNPHARMA','DRREDDY','CIPLA','DIVISLAB','LUPIN','TORNTPHARM','ABBOTTINDIA','AUROPHARMA'],
    'FMCG':       ['HINDUNILVR','ITC','NESTLEIND','BRITANNIA','MARICO','DABUR','GODREJCP','TATACONSUM'],
    'Auto':       ['MARUTI','TATAMOTORS','MM','HEROMOTOCO','BAJAJ_AUTO','TVSMOTOR','EICHERMOT','ASHOKLEY'],
    'Infra':      ['LT','NTPC','POWERGRID','ADANIPORTS','CONCOR','IRB','KNR','PNC'],
    'Metals':     ['TATASTEEL','JSWSTEEL','HINDALCO','VEDL','SAIL','NATIONALUM','NMDC','MOIL'],
    'Realty':     ['DLF','GODREJPROP','OBEROIRLTY','PRESTIGE','BRIGADE','MAHINDRALIFE'],
    'Telecom':    ['BHARTIARTL','VODAFONE','INDUSTOWER','TATACOMM'],
    'US_Tech':    ['NET','NVDA','MSFT','AAPL','GOOGL','META','AMZN','TSLA','AMD','AVGO','PLTR'],
    'US_Energy':  ['CEG','GLNG','LNG','XOM','CVX','COP','SLB','VST','NEE'],
    'US_Finance': ['JPM','GS','MS','BAC','V','MA','BLK'],
    'US_ETF':     ['QQQ','SPY','SOXX','GLD','XLE','INDA','EEM'],
  };

  // Build per-sector instrument data from Firebase
  const sectorInstruments = {};

  // First pass: assign Firebase instruments to their sector group
  Object.values(instruments || {}).forEach(inst => {
    const sym    = inst.symbol || inst.nse || '';
    if (!sym) return;
    const sector = inst.sector || 'Unknown';
    const country= inst.country || 'IN';
    const cal    = inst.calibration || {};
    const val    = inst.valuation   || {};
    const bR     = cal.base_returns?.[regime] ?? 5;
    const sigma  = cal.sigma?.[regime] ?? 0.25;
    const pe     = val.pe;
    const pe5yr  = cal.pe_5yr_avg;
    const roe    = val.roe;
    const de     = val.de;
    const source = cal.source === 'calculated' ? `σ${(sigma*100).toFixed(0)}%` : 'fallback';

    const line = [
      sym,
      `bR:${bR >= 0 ? '+' : ''}${bR}%`,
      source,
      pe && pe5yr ? `PE:${pe.toFixed(0)}vs5yr:${pe5yr.toFixed(0)}` : '',
      roe ? `ROE:${roe.toFixed(0)}%` : '',
      de !== undefined && de !== null ? `DE:${de.toFixed(1)}` : '',
    ].filter(Boolean).join(' ');

    // Find which group this belongs to
    let assigned = false;
    for (const [group, syms] of Object.entries(SECTOR_GROUPS)) {
      if (syms.includes(sym)) {
        if (!sectorInstruments[group]) sectorInstruments[group] = [];
        sectorInstruments[group].push(line);
        assigned = true;
        break;
      }
    }
    // If not in a predefined group, add to sector-based group
    if (!assigned) {
      const groupKey = `${country}_${sector.split(' ')[0].slice(0,10)}`;
      if (!sectorInstruments[groupKey]) sectorInstruments[groupKey] = [];
      sectorInstruments[groupKey].push(line);
    }
  });

  // ── SCORE EACH SECTOR ─────────────────────────────────────
  const allScores  = {};
  const allTop     = [];
  const allAvoid   = [];

  for (const [sectorName, stockLines] of Object.entries(sectorInstruments)) {
    if (stockLines.length === 0) continue;

    const isUS = sectorName.startsWith('US_');
    const sectorPrompt = `You are scoring ${sectorName} sector stocks for an Indian investor.
${regimeContext}

SECTOR: ${sectorName} (${isUS ? 'US stocks' : 'India NSE stocks'})
STOCKS in this sector (symbol baseReturn sigma PE/valuation):
${stockLines.join('\n')}

Score ONLY these ${sectorName} stocks 0-100 relative to each other AND vs other sectors in ${regime} regime.
Consider: Does ${sectorName} sector thrive or suffer in ${regime}? How does each stock compare within sector?

Return ONLY raw JSON, no markdown:
{"scores":{"SYMBOL":{"score":78,"signal":"BUY","reason":"one specific reason under 12 words","regime_fit":8}},"top2":["A","B"],"avoid":["X"]}`;

    try {
      const result = await callHaiku(sectorPrompt, 600);
      if (!result) continue;
      const clean  = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = parseJSON(clean);
      if (parsed?.scores) {
        Object.assign(allScores, parsed.scores);
        if (parsed.top2)  allTop.push(...parsed.top2);
        if (parsed.avoid) allAvoid.push(...parsed.avoid);
        console.log(`  Scored ${sectorName}: ${Object.keys(parsed.scores).length} stocks`);
      }
    } catch(e) {
      console.log(`  ${sectorName} scoring error:`, e.message);
    }

    await new Promise(r => setTimeout(r, 250)); // 250ms between sectors
  }

  if (Object.keys(allScores).length === 0) {
    console.log('All sector scoring failed');
    return null;
  }

  // ── CROSS-SECTOR CALIBRATION ──────────────────────────────
  // Each sector scores independently so scores need calibration
  // Ask Haiku to pick the TOP 5 across all sectors given regime
  const allScoredSymbols = Object.entries(allScores)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 30)
    .map(([sym, s]) => `${sym}:${s.score}(${s.signal})`)
    .join(', ');

  const calibPrompt = `Given ${regime} regime (FII: ${Math.round(fii)} Cr, VIX: ${vix}, Oil: $${brent}):
Top 30 candidates across all sectors: ${allScoredSymbols}

Pick the best 5 overall considering cross-sector regime fit.
Return ONLY raw JSON: {"top5":["A","B","C","D","E"],"avoid":["X","Y","Z"]}`;

  try {
    const calibResult = await callHaiku(calibPrompt, 150);
    const calibClean  = (calibResult || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const calibParsed = parseJSON(calibClean);
    if (calibParsed?.top5) {
      console.log(`AI scored ${Object.keys(allScores).length} instruments. Top 5: ${calibParsed.top5.join(', ')}`);
      return {
        scores: allScores,
        top5:   calibParsed.top5,
        avoid:  calibParsed.avoid || [...new Set(allAvoid)].slice(0, 5),
        regime_note: `${regime} — ${Object.keys(allScores).length} stocks scored across ${Object.keys(sectorInstruments).length} sectors`,
      };
    }
  } catch(e) {
    console.log('Calibration error:', e.message);
  }

  console.log(`AI scored ${Object.keys(allScores).length} instruments`);
  return {
    scores: allScores,
    top5:   [...new Set(allTop)].slice(0, 5),
    avoid:  [...new Set(allAvoid)].slice(0, 5),
    regime_note: `${regime} — sector-aware scoring`,
  };
}


// ── 2. REGIME NARRATIVE ───────────────────────────────────────
async function generateRegimeNarrative(snapshot, scores, chains) {
  const regime  = snapshot.regime || 'SIDEWAYS';
  const fii     = snapshot.fii?.fii_net || 0;
  const vix     = snapshot.indices?.['INDIA VIX']?.last || 17.8;
  const nifty   = snapshot.indices?.['NIFTY 50']?.last;
  const brent   = snapshot.brent || 90;
  const usdInr  = snapshot.usdInr || 92;

  const prompt = `You are an Indian equity market analyst. Write a direct narrative explaining the ${regime} regime call. Under 180 words. Use specific numbers. Actionable tone.

EVIDENCE:
- Regime: ${regime} (score: ${snapshot.regime_score}/5)
- FII: ${fii >= 0 ? '+' : ''}${Math.round(fii)} Cr today (${Math.abs(fii) > 5000 ? 'very significant' : Math.abs(fii) > 2000 ? 'significant' : 'moderate'})
- VIX: ${vix} (${vix < 14 ? 'low fear' : vix < 18 ? 'moderate' : vix < 22 ? 'elevated' : 'high fear'})
- Nifty: ${nifty?.toLocaleString() || 'N/A'}
- Brent: $${brent} (Iran war, Hormuz restricted)
- USD/INR: ${usdInr}
- All 4 major CBs holding rates — tight global liquidity
- Active domino: ${chains?.chains?.[0]?.trigger || 'Iran war LNG disruption'}
- Top picks: ${(scores?.top5 || []).slice(0, 3).join(', ')}

Write 4 sections labeled exactly:
**Why ${regime}** — 2 sentences with specific numbers
**Dominant Theme** — 2 sentences on biggest market driver
**Domino Effects** — 2-3 specific chains active now
**Watch List** — 2-3 catalysts next 2-4 weeks`;

  const result = await callHaiku(prompt, 400);
  return result || `**Why ${regime}:** FII ${fii >= 0 ? 'buying' : 'selling'} ₹${Math.abs(Math.round(fii))} Cr with VIX at ${vix} signals ${regime.toLowerCase()} conditions. All 4 major central banks holding rates creates tight global liquidity headwind.\n\n**Dominant Theme:** Iran war keeping oil at $${brent} — energy and defence benefit, aviation and auto hurt.\n\n**Domino Effects:** GLNG direct beneficiary of LNG disruption. IT/pharma benefit from USD/INR at ${usdInr}.\n\n**Watch List:** RBI MPC Apr 6-8, NET earnings Apr 30, Hormuz developments.`;
}

// ── 3. DOMINO CHAINS ─────────────────────────────────────────
async function getDominoChains(snapshot) {
  const prompt = `Identify 3 active domino chains driving Indian and US markets right now.

CONDITIONS:
- Oil: $${snapshot.brent || 90} (Iran war, Hormuz restricted)
- FII: ${snapshot.fii?.fii_net || 0} Cr | USD/INR: ${snapshot.usdInr || 92}
- VIX: ${snapshot.indices?.['INDIA VIX']?.last || 17.8}
- All CBs holding rates
- Portfolio: NET (Cloudflare), CEG (nuclear power), GLNG (LNG — Iran direct play)

Return ONLY valid JSON:
{
  "chains": [
    {
      "trigger": "Iran war — Hormuz LNG disruption",
      "severity": 5,
      "mechanism": "Hormuz closure → LNG supply shock → FLNG vessels earn premium charter rates",
      "positive": [
        {"stock": "GLNG", "adj": 4, "reason": "Your holding — direct LNG beneficiary"},
        {"stock": "ONGC", "adj": 3, "reason": "Oil revenue at $90+/bbl"}
      ],
      "negative": [
        {"stock": "INTERGLOBE", "adj": -5, "reason": "Jet fuel 35% of costs"},
        {"stock": "MARUTI", "adj": -2, "reason": "Input cost pressure"}
      ]
    }
  ]
}`;

  const result = await callHaiku(prompt, 800);
  return parseJSON(result);
}

// ── 4. NEWS SENTIMENT ─────────────────────────────────────────
async function scoreNewsSentiment(stockNews, marketNews) {
  // If no news passed in, read from Firebase (updated 24/7)
  if (!stockNews || Object.keys(stockNews).length === 0) {
    const { getStockNewsMultiple, getMarketNews } = require('./jobs/newsLoop');
    const topStocks = ['HAL','ONGC','TCS','ICICIBANK','RELIANCE','BEL','PERSISTENT',
                       'NET','CEG','GLNG','NVDA','MSFT','META','LNG','XOM'];
    stockNews  = await getStockNewsMultiple(topStocks).catch(() => ({}));
    marketNews = await getMarketNews().catch(() => []);
  }
  const newsText = Object.entries(stockNews || {})
    .map(([sym, items]) => `${sym}: ${(items || []).slice(0, 2).map(i => i.title).join(' | ')}`)
    .slice(0, 15)
    .join('\n');

  const prompt = `Score news sentiment -3 to +3 for each stock and give market mood.

STOCK NEWS:
${newsText}

MARKET NEWS:
${(marketNews || []).slice(0, 4).map(i => i.title).join('\n')}

Return ONLY valid JSON:
{
  "sentiment": {
    "HAL": {"score": 2.1, "reason": "new contract", "event": "Rs 2901 Cr order"},
    "TCS": {"score": -0.5, "reason": "AI headwinds", "event": null}
  },
  "market_mood": "CAUTIOUS",
  "key_event": "one sentence on biggest market event today"
}`;

  const result = await callHaiku(prompt, 600);
  return parseJSON(result);
}

// ── 5. PORTFOLIO SIGNAL ───────────────────────────────────────
async function getPortfolioSignal(snapshot, scores) {
  const NET  = snapshot.usPrices?.NET  || 225;
  const CEG  = snapshot.usPrices?.CEG  || 317;
  const GLNG = snapshot.usPrices?.GLNG || 51;

  const prompt = `Analyse US portfolio for Indian investor. Return ONLY valid JSON.

NET avg $208.62 now $${NET} | CEG avg $310.43 now $${CEG} | GLNG avg $50.93 now $${GLNG}
USD/INR: ${snapshot.usdInr || 92} | Oil: $${snapshot.brent || 90} | FII: ${snapshot.fii?.fii_net || 0} Cr
Iran war active → GLNG direct beneficiary. NET earnings Apr 30. All CBs holding.
Top India picks: ${(scores?.top5 || []).slice(0, 3).join(', ')}

Return ONLY this JSON:
{"NET":{"action":"HOLD","reason":"one sentence","stop_loss":175,"target":265},"CEG":{"action":"HOLD","reason":"one sentence","stop_loss":270,"target":380},"GLNG":{"action":"ADD","reason":"one sentence","stop_loss":42,"target":68},"coherence":"2 sentence portfolio review","top_india_picks":["HAL","ONGC","TCS"],"weekly_outlook":"2 sentence outlook"}`;

  const result = await callHaiku(prompt, 400);
  return parseJSON(result);
}


module.exports = {
  callHaiku,
  scoreAllInstruments,
  generateRegimeNarrative,
  getDominoChains,
  scoreNewsSentiment,
  getPortfolioSignal,
};
