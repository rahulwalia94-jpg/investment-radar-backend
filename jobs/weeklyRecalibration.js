// ═══════════════════════════════════════════════════════════════
// Weekly Recalibration Job — Phase 3
// Runs every Sunday 2:00 AM IST
// 1. Fetches full Nifty 500 list from NSE
// 2. Gets 52-week price history for each stock
// 3. Calculates REAL sigma (volatility) from actual returns
// 4. Calculates REAL base returns per regime from historical data
// 5. Fetches live P/E, P/B, ROE from Screener.in
// 6. Stores everything in Firebase — no hardcoding
// ═══════════════════════════════════════════════════════════════
const nse      = require('../scrapers/nse');
const screener = require('../scrapers/screener');
const fb       = require('../db');
const ai       = require('../ai');
const storage  = require('../storage');

// ── REGIME CLASSIFIER ─────────────────────────────────────────
// Classify each week in the past year as a regime based on
// VIX + Nifty 50 moving average + FII trend
// This lets us calculate actual returns per regime
function classifyRegimes(niftyHistory) {
  if (!niftyHistory || niftyHistory.length < 20) return [];

  const prices   = niftyHistory.map(d => d.close);
  const classified = [];

  for (let i = 20; i < prices.length; i++) {
    const window   = prices.slice(i - 20, i);
    const sma20    = window.reduce((a, b) => a + b, 0) / window.length;
    const price    = prices[i];
    const momentum = (price - prices[i - 10]) / prices[i - 10] * 100;

    // Calculate recent volatility (proxy for VIX)
    const returns  = window.slice(1).map((p, j) => Math.log(p / window[j]));
    const variance = returns.reduce((s, r) => s + r * r, 0) / returns.length;
    const vol      = Math.sqrt(variance * 252) * 100;

    let regime;
    if (price > sma20 * 1.03 && momentum > 3 && vol < 18)        regime = 'BULL';
    else if (price > sma20 * 1.01 && momentum > 0)                regime = 'SOFT_BULL';
    else if (price < sma20 * 0.97 && momentum < -3 && vol > 22)   regime = 'BEAR';
    else if (price < sma20 * 0.99 && momentum < 0)                regime = 'SOFT_BEAR';
    else                                                            regime = 'SIDEWAYS';

    classified.push({ date: niftyHistory[i].date, regime, price, sma20, vol, momentum });
  }

  return classified;
}

// ── CALCULATE SIGMA (volatility per regime) ───────────────────
function calculateSigma(priceHistory, regimePeriods) {
  if (!priceHistory || priceHistory.length < 10) {
    return { BULL: 0.30, SOFT_BULL: 0.25, SIDEWAYS: 0.20, SOFT_BEAR: 0.28, BEAR: 0.40 };
  }

  // Build date → regime map
  const regimeMap = {};
  regimePeriods.forEach(r => { regimeMap[r.date] = r.regime; });

  // Calculate daily log returns
  const returnsByRegime = { BULL: [], SOFT_BULL: [], SIDEWAYS: [], SOFT_BEAR: [], BEAR: [] };

  for (let i = 1; i < priceHistory.length; i++) {
    const prev   = priceHistory[i - 1].close;
    const curr   = priceHistory[i].close;
    if (!prev || !curr) continue;
    const ret    = Math.log(curr / prev);
    const date   = priceHistory[i].date;
    const regime = regimeMap[date] || 'SIDEWAYS';
    if (returnsByRegime[regime]) returnsByRegime[regime].push(ret);
  }

  const sigma = {};
  Object.entries(returnsByRegime).forEach(([regime, returns]) => {
    if (returns.length < 5) {
      sigma[regime] = regime === 'BEAR' ? 0.40 : regime === 'BULL' ? 0.28 : 0.22;
      return;
    }
    const variance = returns.reduce((s, r) => s + r * r, 0) / returns.length;
    sigma[regime]  = parseFloat(Math.sqrt(variance * 252).toFixed(3));
  });

  return sigma;
}

// ── CALCULATE BASE RETURNS per regime ─────────────────────────
function calculateBaseReturns(priceHistory, regimePeriods) {
  if (!priceHistory || priceHistory.length < 20) {
    return { BULL: 25, SOFT_BULL: 12, SIDEWAYS: 5, SOFT_BEAR: -5, BEAR: -15 };
  }

  // Map dates to prices
  const priceMap = {};
  priceHistory.forEach(d => { priceMap[d.date] = d.close; });

  // Group consecutive same-regime periods and calculate returns
  const regimeReturns = { BULL: [], SOFT_BULL: [], SIDEWAYS: [], SOFT_BEAR: [], BEAR: [] };

  if (regimePeriods.length < 10) return { BULL: 25, SOFT_BULL: 12, SIDEWAYS: 5, SOFT_BEAR: -5, BEAR: -15 };

  // Find regime runs (consecutive same-regime periods)
  let currentRegime = regimePeriods[0].regime;
  let startIdx      = 0;

  for (let i = 1; i <= regimePeriods.length; i++) {
    const atEnd = i === regimePeriods.length;
    if (atEnd || regimePeriods[i].regime !== currentRegime) {
      // Regime period ended — calculate return
      const startPrice = priceMap[regimePeriods[startIdx].date];
      const endPrice   = priceMap[regimePeriods[i - 1].date];
      const days       = i - startIdx;

      if (startPrice && endPrice && days >= 10) {
        // Annualize the return
        const totalReturn   = (endPrice - startPrice) / startPrice;
        const annualized    = totalReturn * (252 / days) * 100;
        // Cap at reasonable bounds
        const capped = Math.max(-60, Math.min(150, annualized));
        regimeReturns[currentRegime].push(capped);
      }

      if (!atEnd) {
        currentRegime = regimePeriods[i].regime;
        startIdx      = i;
      }
    }
  }

  // Average the returns per regime
  const baseReturns = {};
  Object.entries(regimeReturns).forEach(([regime, returns]) => {
    if (returns.length === 0) {
      // Fallback if no data for this regime
      const fallbacks = { BULL: 25, SOFT_BULL: 12, SIDEWAYS: 5, SOFT_BEAR: -5, BEAR: -15 };
      baseReturns[regime] = fallbacks[regime];
    } else {
      const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
      baseReturns[regime] = parseFloat(avg.toFixed(1));
    }
  });

  return baseReturns;
}

// ── MAIN WEEKLY RECALIBRATION ─────────────────────────────────
async function runWeeklyRecalibration() {
  const start = Date.now();
  console.log('\n' + '='.repeat(60));
  console.log('WEEKLY RECALIBRATION STARTED');
  console.log('='.repeat(60));

  const stats = {
    total: 0, calibrated: 0, valuations: 0,
    errors: [], skipped: [],
    started_at: new Date().toISOString(),
  };

  // ── 1. Get Nifty 500 list from NSE ────────────────────────
  console.log('\n[1/6] Fetching Nifty 500 list...');
  const nifty500 = await nse.getNifty500List();
  if (nifty500.length === 0) {
    console.error('Failed to fetch Nifty 500 list — aborting');
    return;
  }
  stats.total = nifty500.length;

  // Save universe list to Firebase
  await fb.saveUniverse('nifty500', nifty500.map(s => s.symbol));
  await fb.saveUniverse('nifty50',  nifty500.slice(0, 50).map(s => s.symbol));
  console.log(`Nifty 500 list saved: ${nifty500.length} stocks`);

  // ── 2. Get Nifty 50 price history for regime classification ─
  console.log('\n[2/6] Fetching Nifty 50 history for regime classification...');
  const niftyHistory = await nse.getPriceHistory('NIFTY 50');
  const regimePeriods = niftyHistory ? classifyRegimes(niftyHistory) : [];
  console.log(`Regime periods classified: ${regimePeriods.length} days`);

  // Log regime distribution
  const regimeCounts = {};
  regimePeriods.forEach(r => { regimeCounts[r.regime] = (regimeCounts[r.regime] || 0) + 1; });
  console.log('Regime distribution:', regimeCounts);

  // ── 3. Get Screener valuations (top 200 first) ────────────
  console.log('\n[3/6] Fetching Screener.in valuations...');
  const top200 = nifty500.slice(0, 200).map(s => s.symbol);
  const { valuations, errors: screenerErrors } = await screener.getBatchValuations(top200, 500);
  stats.valuations = Object.keys(valuations).length;
  console.log(`Valuations: ${stats.valuations} fetched`);

  // ── 4. Calculate calibration for each stock ───────────────
  console.log('\n[4/6] Calculating calibration for each stock...');
  const calibratedInstruments = {};

  // Process in batches of 20 with delays
  const batchSize = 20;
  for (let i = 0; i < nifty500.length; i += batchSize) {
    const batch = nifty500.slice(i, i + batchSize);

    await Promise.all(batch.map(async (stock) => {
      try {
        // Get price history for this stock
        const history = await nse.getPriceHistory(stock.symbol);
        await nse.sleep(200);

        if (!history || history.length < 30) {
          stats.skipped.push(stock.symbol);
          // Save basic data even without calibration
          calibratedInstruments[stock.symbol] = {
            symbol:  stock.symbol,
            name:    stock.name,
            sector:  stock.sector,
            nse:     stock.symbol,
            country: 'IN',
            calibration: {
              base_returns: { BULL: 20, SOFT_BULL: 10, SIDEWAYS: 3, SOFT_BEAR: -5, BEAR: -15 },
              sigma:        { BULL: 0.30, SOFT_BULL: 0.25, SIDEWAYS: 0.20, SOFT_BEAR: 0.28, BEAR: 0.40 },
              source:       'fallback',
              history_days: 0,
            },
            last_price:   stock.lastPrice || 0,
            valuation:    valuations[stock.symbol] || null,
            calibrated_at: new Date().toISOString(),
          };
          return;
        }

        // Calculate sigma and base returns from real price data
        const sigma       = calculateSigma(history, regimePeriods);
        const baseReturns = calculateBaseReturns(history, regimePeriods);

        // Get historical PE for valuation context
        let historicalPE = null;
        if (valuations[stock.symbol]?.pe) {
          historicalPE = await screener.getHistoricalPE(stock.symbol);
          await nse.sleep(300);
        }

        // Store last 252 days of price history for GARCH/DCC
        const priceHistory = history.slice(-252).map(d => ({
          date:  d.date,
          close: d.close,
          high:  d.high  || d.close,
          low:   d.low   || d.close,
          vol:   d.vol   || 0,
        }));
        // Collect for SQLite upload
        allPriceHistories[stock.symbol] = priceHistory;

        calibratedInstruments[stock.symbol] = {
          symbol:   stock.symbol,
          name:     stock.name,
          sector:   stock.sector,
          nse:      stock.symbol,
          country:  'IN',
          calibration: {
            base_returns:  baseReturns,
            sigma,
            source:        'calculated',
            history_days:  history.length,
            regime_periods: regimePeriods.length,
            pe_5yr_avg:    historicalPE?.pe_5yr_avg || null,
            pe_min:        historicalPE?.pe_min     || null,
            pe_max:        historicalPE?.pe_max     || null,
          },
          last_price:    history[history.length - 1]?.close || stock.lastPrice,
          week52_high:   Math.max(...history.map(d => d.high || d.close)),
          week52_low:    Math.min(...history.map(d => d.low  || d.close)),
          valuation:     valuations[stock.symbol] || null,
          calibrated_at:  new Date().toISOString(),
        };

        stats.calibrated++;
      } catch (e) {
        console.error(`Error calibrating ${stock.symbol}:`, e.message);
        stats.errors.push({ symbol: stock.symbol, error: e.message });
      }
    }));

    // Save batch to Firebase
    if (Object.keys(calibratedInstruments).length > 0) {
      await fb.bulkSaveInstruments(calibratedInstruments);
      console.log(`  Progress: ${i + batchSize}/${nifty500.length} | Calibrated: ${stats.calibrated}`);
    }

    await nse.sleep(1000); // 1 second between batches
  }

  // ── 5. Add ALL US stocks with real price history ─────────────
  console.log('\n[5/6] Calibrating all US stocks from Yahoo price history...');
  const { US_UNIVERSE, getAllUSSymbols, getYahooSymbol } = require('../shared/us_instruments');

  const usInstruments = {};
  const allUSSymbols  = getAllUSSymbols();

  for (const symbol of allUSSymbols) {
    try {
      const yahooSym  = getYahooSymbol(symbol);
      const usMeta    = US_UNIVERSE[symbol];

      // Fetch 52-week price history from Yahoo
      const r = await new Promise(resolve => {
        const https  = require('https');
        const zlib   = require('zlib');
        const end    = Math.floor(Date.now() / 1000);
        const start  = end - 365 * 24 * 3600;
        const url    = `/v8/finance/chart/${yahooSym}?interval=1d&period1=${start}&period2=${end}`;
        const req    = https.get({
          hostname: 'query1.finance.yahoo.com',
          path:     url,
          headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Accept-Encoding': 'gzip' },
          timeout:  10000,
        }, res => {
          let data   = '';
          let stream = res;
          if (res.headers['content-encoding'] === 'gzip') stream = res.pipe(zlib.createGunzip());
          stream.on('data', c => data += c.toString());
          stream.on('end', () => {
            try { resolve({ ok: true, data: JSON.parse(data) }); }
            catch (e) { resolve({ ok: false }); }
          });
        });
        req.on('error', () => resolve({ ok: false }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      });

      let calibration = {
        base_returns: { BULL: 25, SOFT_BULL: 12, SIDEWAYS: 5, SOFT_BEAR: -5, BEAR: -20 },
        sigma:        { BULL: 0.30, SOFT_BULL: 0.25, SIDEWAYS: 0.20, SOFT_BEAR: 0.28, BEAR: 0.40 },
        source:       'fallback',
        history_days: 0,
      };

      if (r.ok && r.data?.chart?.result?.[0]) {
        const result  = r.data.chart.result[0];
        const closes  = result.indicators?.quote?.[0]?.close || [];
        const times   = result.timestamp || [];
        const history = times.map((t, i) => ({ date: new Date(t*1000).toISOString().slice(0,10), close: closes[i] }))
          .filter(d => d.close);

        if (history.length >= 30) {
          // Use same regime periods from Nifty 50 as proxy
          // (US regime roughly correlates with India regime)
          const sigma       = calculateSigma(history, regimePeriods);
          const baseReturns = calculateBaseReturns(history, regimePeriods);
          calibration = {
            base_returns:  baseReturns,
            sigma,
            source:        'calculated',
            history_days:  history.length,
          };
        }
      }

      usInstruments[symbol] = {
        symbol,
        name:     usMeta.name,
        sector:   usMeta.sector,
        rc:       usMeta.rc,
        country:  'US',
        dv:       usMeta.dv || 0,
        tags:     usMeta.tags || [],
        yourPos:  usMeta.yourPos || null,
        calibration,
        calibrated_at: new Date().toISOString(),
      };

      await nse.sleep(200);
    } catch (e) {
      console.error(`US calibration error ${symbol}:`, e.message);
    }
  }

  await fb.bulkSaveInstruments(usInstruments);
  await fb.saveUniverse('us_stocks', allUSSymbols);
  console.log(`US stocks calibrated: ${Object.keys(usInstruments).length}/${allUSSymbols.length}`);

  // ── 6. Generate AI context for top stocks ─────────────────
  console.log('\n[6/6] Generating AI context for top 50 stocks...');
  const top50 = nifty500.slice(0, 50);
  for (const stock of top50.slice(0, 20)) { // top 20 first
    try {
      const val = valuations[stock.symbol];
      const cal = calibratedInstruments[stock.symbol]?.calibration;
      const context = await ai.generateStockContext(stock, val, cal);
      if (context) {
        await fb.saveInstrument(stock.symbol, { ai_context: context });
      }
      await nse.sleep(300);
    } catch (e) {
      console.error(`AI context error for ${stock.symbol}:`, e.message);
    }
  }

  // ── Save calibration run log ───────────────────────────────
  const elapsed = Math.round((Date.now() - start) / 1000);
  stats.elapsed_seconds = elapsed;
  stats.completed_at    = new Date().toISOString();

  await fb.saveCalibrationRun(stats);

  console.log('\n' + '='.repeat(60));
  console.log('RECALIBRATION COMPLETE');
  console.log(`  Total stocks:  ${stats.total}`);
  console.log(`  Calibrated:    ${stats.calibrated}`);
  console.log(`  Valuations:    ${stats.valuations}`);
  console.log(`  Skipped:       ${stats.skipped.length}`);
  console.log(`  Errors:        ${stats.errors.length}`);
  console.log(`  Time:          ${Math.round(elapsed/60)}m ${elapsed%60}s`);
  console.log('='.repeat(60));

  return stats;
}

module.exports = { runWeeklyRecalibration, classifyRegimes, calculateSigma, calculateBaseReturns };
