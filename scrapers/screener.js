// ═══════════════════════════════════════════════════════════════
// Screener.in Scraper — Phase 3
// Fetches live P/E, P/B, ROE, revenue growth, debt/equity,
// promoter holding for all Nifty 500 stocks
// ═══════════════════════════════════════════════════════════════
const https = require('https');
const zlib  = require('zlib');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── FETCH SCREENER PAGE ───────────────────────────────────────
function fetchScreenerPage(symbol) {
  return new Promise(resolve => {
    // Try consolidated first, then standalone
    const path = `/company/${symbol}/consolidated/`;
    const req = https.get({
      hostname: 'www.screener.in',
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 12000,
    }, res => {
      let html = '';
      res.on('data', c => html += c.toString());
      res.on('end', () => resolve({ ok: true, html, status: res.statusCode }));
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
  });
}

// ── PARSE SCREENER HTML ───────────────────────────────────────
function parseScreener(html, symbol) {
  if (!html || html.length < 500) return null;

  const getVal = (patterns) => {
    for (const pattern of patterns) {
      const re  = new RegExp(pattern, 'i');
      const m   = html.match(re);
      if (m) {
        const val = parseFloat((m[1] || m[2] || '').replace(/,/g, '').trim());
        if (!isNaN(val) && val !== 0) return val;
      }
    }
    return null;
  };

  // Key ratios section patterns
  const pe  = getVal([
    'Stock P/E[^<]*<[^>]*>[^<]*<[^>]*>\\s*([\\d,\\.]+)',
    'P/E[^<]*</li>[^<]*<li>[^<]*<span[^>]*>([\\d,\\.]+)',
    '"stockPE"[^>]*>([\\d,\\.]+)',
  ]);

  const pb  = getVal([
    'Price to Book[^<]*<[^>]*>[^<]*<[^>]*>\\s*([\\d,\\.]+)',
    'P/B[^<]*<span[^>]*>([\\d,\\.]+)',
  ]);

  const roe = getVal([
    'Return on equity[^<]*<[^>]*>[^<]*<[^>]*>\\s*([\\d,\\.]+)',
    'ROE[^<]*<span[^>]*>([\\d,\\.]+)',
    'Return on Equity[^>]*>\\s*([\\d,\\.]+)',
  ]);

  const de = getVal([
    'Debt to equity[^<]*<[^>]*>[^<]*<[^>]*>\\s*([\\d,\\.]+)',
    'Debt/Equity[^<]*<span[^>]*>([\\d,\\.]+)',
  ]);

  const roce = getVal([
    'ROCE[^<]*<[^>]*>[^<]*<[^>]*>\\s*([\\d,\\.]+)',
    'Return on Capital Employed[^>]*>\\s*([\\d,\\.]+)',
  ]);

  const mcap = getVal([
    'Market Cap[^<]*<[^>]*>[^<]*<[^>]*>\\s*([\\d,\\.]+)',
    'marketcap[^>]*>\\s*([\\d,\\.]+)',
  ]);

  // Promoter holding
  const promoter = getVal([
    'Promoter[^<]*<[^>]*>\\s*([\\d,\\.]+)\\s*%',
    'promoterHolding[^>]*>\\s*([\\d,\\.]+)',
  ]);

  // Sales growth (TTM)
  const salesGrowth = getVal([
    'Sales growth[^<]*<[^>]*>[^<]*<[^>]*>\\s*(-?[\\d,\\.]+)',
    'Revenue Growth[^>]*>\\s*(-?[\\d,\\.]+)',
  ]);

  // Profit growth
  const profitGrowth = getVal([
    'Profit growth[^<]*<[^>]*>[^<]*<[^>]*>\\s*(-?[\\d,\\.]+)',
    'PAT Growth[^>]*>\\s*(-?[\\d,\\.]+)',
  ]);

  // Dividend yield
  const divYield = getVal([
    'Dividend Yield[^<]*<[^>]*>[^<]*<[^>]*>\\s*([\\d,\\.]+)',
    'dividendYield[^>]*>\\s*([\\d,\\.]+)',
  ]);

  const result = { symbol, pe, pb, roe, de, roce, mcap, promoter, salesGrowth, profitGrowth, divYield };

  // Only return if we got at least PE or ROE
  if (!pe && !roe && !pb) return null;

  return result;
}

// ── FETCH SINGLE STOCK VALUATION ──────────────────────────────
async function getValuation(symbol) {
  try {
    const r = await fetchScreenerPage(symbol);
    if (!r.ok) return null;
    if (r.status === 404) {
      // Try standalone (non-consolidated)
      const r2 = await new Promise(resolve => {
        const req = https.get({
          hostname: 'www.screener.in',
          path:     `/company/${symbol}/`,
          headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
          timeout:  10000,
        }, res => {
          let html = '';
          res.on('data', c => html += c.toString());
          res.on('end', () => resolve({ ok: true, html }));
        });
        req.on('error', e => resolve({ ok: false }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      });
      if (!r2.ok) return null;
      return parseScreener(r2.html, symbol);
    }
    return parseScreener(r.html, symbol);
  } catch (e) {
    console.error(`Screener error for ${symbol}:`, e.message);
    return null;
  }
}

// ── BATCH FETCH VALUATIONS ────────────────────────────────────
// Fetches valuations for a list of symbols with rate limiting
async function getBatchValuations(symbols, delayMs = 400) {
  const valuations = {};
  const errors     = [];
  let   count      = 0;

  console.log(`Fetching Screener valuations for ${symbols.length} stocks...`);

  for (const sym of symbols) {
    try {
      const val = await getValuation(sym);
      if (val) {
        valuations[sym] = val;
        count++;
      } else {
        errors.push(sym);
      }
    } catch (e) {
      errors.push(sym);
    }
    await sleep(delayMs);

    // Progress log every 20 stocks
    if ((symbols.indexOf(sym) + 1) % 20 === 0) {
      console.log(`  Screener: ${count} valuations fetched, ${errors.length} failed`);
    }
  }

  console.log(`Screener complete: ${count} valuations, ${errors.length} errors`);
  return { valuations, errors };
}

// ── 5-YEAR AVERAGE PE from historical data ────────────────────
// Screener has historical PE data — scrape it for 5yr average
async function getHistoricalPE(symbol) {
  try {
    // Screener API endpoint for historical data
    const r = await new Promise(resolve => {
      const req = https.get({
        hostname: 'www.screener.in',
        path:     `/api/company/${symbol}/?format=json`,
        headers:  {
          'User-Agent': 'Mozilla/5.0',
          'Accept':     'application/json',
          'Referer':    `https://www.screener.in/company/${symbol}/`,
        },
        timeout: 10000,
      }, res => {
        let data = '';
        res.on('data', c => data += c.toString());
        res.on('end', () => {
          try { resolve({ ok: true, data: JSON.parse(data) }); }
          catch (e) { resolve({ ok: false }); }
        });
      });
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    });

    if (!r.ok || !r.data) return null;

    // Extract PE history
    const peData = r.data?.ratios?.find?.(row => row.name === 'Price to Earning');
    if (!peData?.values) return null;

    const peValues = peData.values
      .slice(-20) // last 20 quarters = 5 years
      .map(v => parseFloat(v))
      .filter(v => !isNaN(v) && v > 0 && v < 200); // sanity filter

    if (peValues.length === 0) return null;

    return {
      pe_5yr_avg: peValues.reduce((a, b) => a + b, 0) / peValues.length,
      pe_min:     Math.min(...peValues),
      pe_max:     Math.max(...peValues),
      pe_history: peValues,
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  getValuation,
  getBatchValuations,
  getHistoricalPE,
  sleep,
};
