// ═══════════════════════════════════════════════════════════════
// Morning Refresh — Phase 3
// Reads instrument calibration from Firebase (not hardcoded)
// Fetches all live data, runs AI, stores results, sends WhatsApp
// ═══════════════════════════════════════════════════════════════
const nse = require('../scrapers/nse');
const fb  = require('../db');
const ai  = require('../ai');
const tg  = require('../telegram'); // free Telegram notifications
const fcm = require('../fcm');     // Android push notifications (free)

async function runMorningRefresh() {
  const start = Date.now();
  console.log('\n' + '='.repeat(50));
  console.log('MORNING REFRESH — ' + new Date().toISOString());
  console.log('='.repeat(50));

  const snap = {
    label:    'India Open 9:00 AM',
    ts:       new Date().toISOString(),
    prices:   {},
    fii:      null,
    indices:  {},
    gainers:  [],
    losers:   [],
    results:  [],
    dividends:[],
    usdInr:   null,
    brent:    null,
    gold:     null,
    usPrices: {},
    regime:   'SIDEWAYS',
    errors:   [],
    success:  [],
  };

  // 1. Load instruments from Firebase (not hardcoded)
  console.log('Loading instruments from Firebase...');
  const instruments = await fb.getAllInstruments();
  const instCount   = Object.keys(instruments).length;
  console.log(`Loaded ${instCount} instruments`);

  // If no instruments yet (first run) — this is ok, AI will still work
  if (instCount === 0) {
    snap.errors.push('no_instruments: run weekly recalibration first');
  }

  // 2. Get Nifty 500 symbol list
  const nifty500Syms = await fb.getUniverse('nifty500');
  // Handle first run before recalibration — use hardcoded top stocks
  const DEFAULT_SYMBOLS = [
    'TCS','INFY','HCLTECH','WIPRO','PERSISTENT','LTIM','SUNPHARMA','DRREDDY',
    'ICICIBANK','HDFCBANK','SBIN','AXISBANK','BAJFINANCE','HAL','BEL','MARUTI',
    'TATAMOTORS','HINDUNILVR','ITC','LT','NTPC','ONGC','RELIANCE','BHARTIARTL',
    'DLF','TATASTEEL','DIXION','GOLDBEES','INDIGO','BAJAJFINSV',
  ];
  const instSymbols = Object.values(instruments || {})
    .filter(i => i && i.country === 'IN' && (i.nse || i.symbol))
    .map(i => i.nse || i.symbol)
    .slice(0, 100);
  const symbolsToFetch = nifty500Syms.length > 0
    ? nifty500Syms.slice(0, 100)
    : instSymbols.length > 0
      ? instSymbols
      : DEFAULT_SYMBOLS;

  // 3. Fetch live NSE prices
  console.log(`Fetching prices for ${symbolsToFetch.length} stocks...`);
  await nse.refreshCookie();
  await nse.sleep(2000);

  const { prices } = await nse.getBulkQuotes(symbolsToFetch);
  snap.prices   = prices;
  snap.success.push(`prices:${Object.keys(prices).length}`);

  // Update last_price in Firebase instruments
  const priceUpdates = {};
  Object.entries(prices).forEach(([sym, price]) => {
    priceUpdates[sym] = { last_price: price, price_updated_at: new Date().toISOString() };
  });
  if (Object.keys(priceUpdates).length > 0) {
    await fb.bulkSaveInstruments(priceUpdates);
  }

  // 4. FII/DII
  const fii = await nse.getFII();
  if (fii) {
    snap.fii = fii;
    snap.success.push(`fii:${fii.fii_net}Cr`);
  } else {
    snap.errors.push('fii:failed');
  }

  // 5. Indices
  const indices = await nse.getIndices();
  snap.indices  = indices;
  snap.success.push(`indices:${Object.keys(indices).length}`);

  // 6. Gainers/Losers
  const movers  = await nse.getMovers();
  snap.gainers  = movers.gainers;
  snap.losers   = movers.losers;

  // 7. Results calendar
  const cal     = await nse.getResultsCalendar();
  snap.results  = cal.results;
  snap.dividends= cal.dividends;

  // 8. Yahoo macro + ALL US prices (105 stocks)
  const { US_UNIVERSE, getYahooSymbol, getAllUSSymbols } = require('../shared/us_instruments');
  const macro     = await nse.getMacro();
  const allUSSyms = getAllUSSymbols().map(getYahooSymbol);
  const usPrices  = await nse.getAllUSPrices(allUSSyms);

  if (macro.usdInr) {
    snap.usdInr  = macro.usdInr;
    snap.brent   = macro.brent;
    snap.gold    = macro.gold;
    snap.usPrices= usPrices;
    snap.success.push(`yahoo:${macro.usdInr} | usPrices:${Object.keys(usPrices).length}`);
  } else {
    snap.errors.push('yahoo:macro_failed');
    snap.usPrices = usPrices; // still save prices even if macro failed
  }

  // Update US prices in Firebase instruments
  const usUpdates = {};
  Object.entries(usPrices).forEach(([sym, price]) => {
    usUpdates[sym] = { last_price: price, price_updated_at: new Date().toISOString() };
  });
  if (Object.keys(usUpdates).length > 0) await fb.bulkSaveInstruments(usUpdates);

  // 9. Regime classification
  const fiiNet  = snap.fii?.fii_net || 0;
  const vix     = snap.indices?.['INDIA VIX']?.last || 18;
  const niftyChg= snap.indices?.['NIFTY 50']?.pChange || 0;
  let regScore  = 0;
  if (fiiNet > 3000)        regScore += 2;
  else if (fiiNet > 0)      regScore += 1;
  else if (fiiNet < -5000)  regScore -= 2;
  else if (fiiNet < 0)      regScore -= 1;
  if (vix < 14)             regScore += 2;
  else if (vix < 18)        regScore += 0;
  else if (vix > 22)        regScore -= 2;
  else if (vix > 18)        regScore -= 1;
  if (niftyChg > 1)         regScore += 1;
  else if (niftyChg < -1)   regScore -= 1;
  snap.regime       = regScore >= 3 ? 'BULL' : regScore >= 1 ? 'SOFT_BULL' : regScore >= -1 ? 'SIDEWAYS' : regScore >= -3 ? 'SOFT_BEAR' : 'BEAR';
  snap.regime_score = regScore;

  // 10. News — read from Firebase (newsLoop updates 24/7, no need to fetch here)
  const { getStockNewsMultiple, getMarketNews } = require('./newsLoop');
  const topStocks = ['HAL','ONGC','TCS','ICICIBANK','RELIANCE','BEL','PERSISTENT',
                     'NET','CEG','GLNG','NVDA','MSFT','META','LNG','BHARTIARTL'];
  const [newsItems, mkNews] = await Promise.all([
    getStockNewsMultiple(topStocks).catch(() => ({})),
    getMarketNews().catch(() => []),
  ]);
  snap.success.push(`news:${Object.keys(newsItems).length}stocks_from_firebase`);

  // 11. Save snapshot
  await fb.saveSnapshot(snap);

  let scores = {}; // initialized here, populated by Python engine or Haiku fallback

  // 12. Run Python Quant Engine (GARCH + DCC + Factor Model + Monte Carlo)
  console.log('Running Python quant engine...');
  const prefs = await fb.getPreferences();
  try {
    const { execSync } = require('child_process');
    const pyResult = execSync(
      'python3 scoring/run_scoring.py',
      {
        cwd:     '/opt/render/project/src',
        timeout: 300000,
        env:     { ...process.env },
      }
    ).toString();
    const lines    = pyResult.trim().split('\n');
    const jsonLine = lines.filter(l => l.startsWith('{')).pop();
    const result   = jsonLine ? JSON.parse(jsonLine) : {};
    if (result.ok) {
      console.log(`Python quant engine complete ✅ (${result.scored} scored, ${result.elapsed}s)`);
      snap.success = snap.success || [];
      snap.success.push(`quant:${result.scored}stocks`);
      snap.model = 'python-quant-v1';
      await fb.saveSnapshot(snap);
    } else {
      throw new Error(result.error || 'Python engine returned ok:false');
    }
  } catch(e) {
    console.log('Python engine error:', e.message?.slice(0, 200));
    snap.errors = snap.errors || [];
    snap.errors.push('quant:' + (e.message?.slice(0,100) || 'failed'));
    await runHaikuFallback(snap, instruments);
  }

  // 14. News already in Firebase from continuous newsLoop — no manual save needed

  // 15. Send FCM push notification (free) + Telegram

  // FCM push to Android app (free, primary)
  const analysis = await fb.getLatestAIAnalysis().catch(() => ({}));
  const fcmResult = await fcm.sendMorningBrief(snap, analysis?.scores, prefs.portfolio);
  if (fcmResult.ok) {
    await fb.logAlert({ type: 'MORNING_BRIEF_FCM', messageId: fcmResult.messageId });
  }

  // Telegram notification (free)
  await tg.sendMorningBrief(snap, analysis?.scores, prefs.portfolio).catch(e => console.log('Telegram error:', e.message));


  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`\n✅ Morning refresh done in ${elapsed}s`);
  console.log(`   Regime: ${snap.regime} (${regScore})`);
  console.log(`   Prices: ${Object.keys(snap.prices).length}`);

  return { snap, scores };
}

async function runMiddayUpdate() {
  const prevSnap = await fb.getLatestSnapshot();
  const prefs    = await fb.getPreferences();

  await nse.refreshCookie();
  await nse.sleep(1500);

  // Quick update — prices + FII + US prices only
  const nifty500Syms = await fb.getUniverse('nifty500');
  const topSyms      = nifty500Syms.slice(0, 50);
  const { prices }   = await nse.getBulkQuotes(topSyms);
  const fii          = await nse.getFII();
  const macro        = await nse.getMacro();

  const snap = {
    ...(prevSnap || {}),
    label:    'Midday Update',
    ts:       new Date().toISOString(),
    prices:   { ...(prevSnap?.prices || {}), ...prices },
    fii:      fii || prevSnap?.fii,
    usdInr:   macro.usdInr  || prevSnap?.usdInr,
    brent:    macro.brent   || prevSnap?.brent,
    usPrices: macro.usPrices || prevSnap?.usPrices || {},
  };

  await fb.saveSnapshot(snap);

  // Threshold alerts
  const latestAnalysis = await fb.getLatestAIAnalysis();
  const alerts = latestAnalysis?.alerts || [];
  for (const alert of alerts) {
    if (alert.type === 'PRICE_MOVE' && prefs.phone) {
      const pos = prefs.portfolio?.[alert.stock];
      const msg = `⚡ *ALERT — ${alert.stock}*\n\nMoved ${alert.move_pct >= 0 ? '+' : ''}${alert.move_pct}% today\nCurrent: $${alert.current} | Avg: $${pos?.avg}\nP&L: ${alert.pl_pct >= 0 ? '+' : ''}${alert.pl_pct}%\n\n→ ${process.env.DASHBOARD_URL}`;
    }
  }

  console.log(`Midday update done | Prices: ${Object.keys(prices).length} | Alerts: ${alerts.length}`);
}

async function runEveningSummary() {
  const snap     = await fb.getLatestSnapshot();
  const analysis = await fb.getLatestAIAnalysis();
  const prefs    = await fb.getPreferences();

  if (!snap || !prefs.phone) return;

  if (brief) {
    const r = await tg.sendMorningBrief(snap, scores, prefs.portfolio);
    if (r.ok) await fb.logAlert({ type: 'EVENING_SUMMARY', phone: prefs.phone, sid: r.sid });
    console.log(`Evening summary: ${r.ok ? '✅' : '❌'}`);
  }
}

// Haiku fallback if Python engine fails
async function runHaikuFallback(snap, instruments) {
  console.log('Running Haiku fallback scoring...');
  try {
    const ai = require('../ai');
    const [scores, chains] = await Promise.all([
      ai.scoreAllInstruments(snap, instruments || {}).catch(() => null),
      ai.getDominoChains(snap).catch(() => null),
    ]);
    const narrative = await ai.generateRegimeNarrative(snap, scores, chains).catch(() => null);
    const portSig   = await ai.getPortfolioSignal(snap, scores).catch(() => null);
    const fb = require('../db');
    await fb.saveAIAnalysis({
      scores, chains,
      regimeNarrative: narrative,
      portfolioSignal: portSig,
      market_mood:     'NEUTRAL',
      generated_at:    new Date().toISOString(),
      model:           'haiku-fallback',
    });
    console.log('Haiku fallback complete ✅');
  } catch(e) {
    console.log('Haiku fallback error:', e.message);
  }
}

module.exports = { runMorningRefresh, runMiddayUpdate, runEveningSummary };
