// ═══════════════════════════════════════════════════════════════
// NSE Scraper — Phase 3
// Fetches: Nifty 500 constituent list, price history,
//          current quotes, FII, indices, corporate actions
// ═══════════════════════════════════════════════════════════════
const https = require('https');
const zlib  = require('zlib');

let NSE_COOKIE    = '';
let COOKIE_TS     = 0;
const COOKIE_TTL  = 20 * 60 * 1000; // 20 min

// ── COOKIE ────────────────────────────────────────────────────
function refreshCookie() {
  return new Promise(resolve => {
    const req = https.get('https://www.nseindia.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 10000,
    }, res => {
      const cookies = res.headers['set-cookie'] || [];
      res.on('data', () => {});
      res.on('end', () => {
        if (cookies.length) {
          NSE_COOKIE = cookies.map(c => c.split(';')[0]).join('; ');
          COOKIE_TS  = Date.now();
          console.log('NSE cookie refreshed');
        }
        resolve(NSE_COOKIE);
      });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

async function getCookie() {
  if (!NSE_COOKIE || Date.now() - COOKIE_TS > COOKIE_TTL) {
    await refreshCookie();
    await sleep(1500); // wait after cookie before API calls
  }
  return NSE_COOKIE;
}

// ── GENERIC FETCH ─────────────────────────────────────────────
function fetchURL(hostname, path, headers = {}, timeout = 12000) {
  return new Promise(resolve => {
    const req = https.request({ hostname, path, method: 'GET', headers, timeout }, res => {
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      let data = '';
      stream.on('data', c => data += c.toString());
      stream.on('end', () => {
        try {
          resolve({ ok: true, data: JSON.parse(data), status: res.statusCode });
        } catch (e) {
          if (data.includes('<html') || data.includes('<!DOCTYPE')) {
            NSE_COOKIE = ''; // force cookie refresh
            resolve({ ok: false, error: 'HTML_RESPONSE', raw: data.slice(0, 100) });
          } else {
            resolve({ ok: false, error: 'JSON_PARSE: ' + e.message, raw: data.slice(0, 100) });
          }
        }
      });
      stream.on('error', e => resolve({ ok: false, error: e.message }));
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
    req.end();
  });
}

async function fetchNSE(path, retry = true) {
  const cookie = await getCookie();
  const r = await fetchURL('www.nseindia.com', path, {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer':         'https://www.nseindia.com/',
    'Cookie':          cookie,
    'sec-fetch-dest':  'empty',
    'sec-fetch-mode':  'cors',
    'sec-fetch-site':  'same-origin',
  });

  // Auto-retry once on HTML response (cookie expired)
  if (!r.ok && r.error === 'HTML_RESPONSE' && retry) {
    console.log(`NSE HTML for ${path} — refreshing cookie and retrying`);
    NSE_COOKIE = '';
    await refreshCookie();
    await sleep(2000);
    return fetchNSE(path, false);
  }
  return r;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── NIFTY 500 CONSTITUENT LIST ────────────────────────────────
async function getNifty500List() {
  console.log('Fetching Nifty 500 constituent list...');
  const r = await fetchNSE('/api/equity-stockIndices?index=NIFTY%20500');
  if (!r.ok) {
    console.error('Failed to fetch Nifty 500 list:', r.error);
    return [];
  }
  const stocks = (r.data?.data || []).map(s => ({
    symbol:   s.symbol,
    name:     s.meta?.companyName || s.symbol,
    sector:   s.meta?.industry    || 'Unknown',
    series:   s.series || 'EQ',
    lastPrice: s.lastPrice || 0,
  }));
  console.log(`Nifty 500: ${stocks.length} stocks`);
  return stocks;
}

// ── PRICE HISTORY (52 weeks) for sigma calculation ────────────

function getDateString(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function getPriceHistory(symbol, fromDate, toDate) {
  const from = fromDate || getDateString(-365); // 1 year back
  const to   = toDate   || getDateString(0);    // today
  const path = `/api/historical/cm/equity?symbol=${encodeURIComponent(symbol)}&series=["EQ"]&from=${from}&to=${to}`;
  const r = await fetchNSE(path);
  if (!r.ok) return null;

  const rows = r.data?.data || [];
  return rows.map(d => ({
    date:  d.CH_TIMESTAMP || d.mTIMESTAMP,
    close: parseFloat(d.CH_CLOSING_PRICE || d.VWAP || 0),
    open:  parseFloat(d.CH_OPENING_PRICE || 0),
    high:  parseFloat(d.CH_TRADE_HIGH_PRICE || 0),
    low:   parseFloat(d.CH_TRADE_LOW_PRICE || 0),
    vol:   parseInt(d.CH_TOT_TRADED_QTY || 0),
  })).filter(d => d.close > 0);
}

// ── CURRENT QUOTE (single stock) ─────────────────────────────
async function getQuote(symbol) {
  const r = await fetchNSE(`/api/quote-equity?symbol=${encodeURIComponent(symbol)}`);
  if (!r.ok) return null;
  const pi = r.data?.priceInfo;
  const di = r.data?.metadata;
  if (!pi) return null;
  return {
    symbol,
    price:     pi.lastPrice,
    change:    pi.change,
    pChange:   pi.pChange,
    open:      pi.open,
    high:      pi.intraDayHighLow?.max,
    low:       pi.intraDayHighLow?.min,
    prevClose: pi.previousClose,
    week52High: pi.weekHighLow?.max,
    week52Low:  pi.weekHighLow?.min,
    pe:        r.data?.metadata?.pdSymbolPe,
    pb:        null, // from Screener
    marketCap: r.data?.industryInfo?.macroMktCap,
  };
}

// ── BULK QUOTES (all Nifty 500 prices in one call) ────────────
async function getBulkQuotes(symbols) {
  console.log(`Fetching bulk quotes for ${symbols.length} symbols...`);
  const prices = {};
  const errors = [];

  // NSE bulk endpoint — processes 50 at a time
  const batchSize = 50;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    // Try market data endpoint first
    const symsParam = batch.map(s => encodeURIComponent(s)).join('%2C');
    const r = await fetchNSE(`/api/market-data-pre-open?key=NIFTY&symbol=${symsParam}`);

    if (r.ok && r.data?.data) {
      r.data.data.forEach(item => {
        if (item.metadata?.lastPrice) prices[item.metadata.symbol] = item.metadata.lastPrice;
      });
    } else {
      // Fallback: individual quotes for failed batch
      for (const sym of batch) {
        const q = await getQuote(sym);
        if (q?.price) prices[sym] = q.price;
        await sleep(150);
      }
    }
    await sleep(400);
    console.log(`  Prices: ${Object.keys(prices).length}/${symbols.length}`);
  }

  return { prices, errors };
}

// ── FII/DII ───────────────────────────────────────────────────
async function getFII() {
  const r = await fetchNSE('/api/fiidiiTradeReact');
  if (!r.ok) return null;
  try {
    const arr = Array.isArray(r.data) ? r.data : (r.data?.data || []);
    const byDate = {};
    arr.forEach(row => {
      const d = row.date || row.Date || '';
      if (!byDate[d]) byDate[d] = {};
      byDate[d][(row.category || '').toUpperCase()] = row;
    });
    const dates = Object.keys(byDate).sort().reverse();
    const latest = byDate[dates[0]] || {};
    const fRow = latest['FII'] || latest['FII/FPI'] || {};
    const dRow = latest['DII'] || {};
    const g = (row, ...keys) => {
      for (const k of keys) { const v = parseFloat(row[k] || 0); if (v !== 0) return v; }
      return 0;
    };
    return {
      date:     dates[0],
      fii_net:  g(fRow, 'netValue', 'fiiNet'),
      fii_buy:  g(fRow, 'buyValue', 'fiiBuy'),
      fii_sell: g(fRow, 'sellValue', 'fiiSell'),
      dii_net:  g(dRow, 'netValue', 'diiNet'),
      dii_buy:  g(dRow, 'buyValue', 'diiBuy'),
      dii_sell: g(dRow, 'sellValue', 'diiSell'),
      trend: dates.slice(0, 7).map(d => ({
        date:    d,
        fii_net: g(byDate[d]['FII'] || byDate[d]['FII/FPI'] || {}, 'netValue'),
        dii_net: g(byDate[d]['DII'] || {}, 'netValue'),
      })),
    };
  } catch (e) {
    console.error('FII parse error:', e.message);
    return null;
  }
}

// ── INDICES ───────────────────────────────────────────────────
async function getIndices() {
  const r = await fetchNSE('/api/allIndices');
  if (!r.ok) return {};
  const want = ['NIFTY 50', 'NIFTY 500', 'NIFTY BANK', 'NIFTY IT',
                'INDIA VIX', 'NIFTY DEFENCE', 'NIFTY MIDCAP 100',
                'NIFTY PHARMA', 'NIFTY AUTO', 'NIFTY INFRA'];
  const result = {};
  (r.data?.data || []).filter(i => want.includes(i.index)).forEach(i => {
    result[i.index] = {
      last:    i.last,
      change:  i.change,
      pChange: i.percentChange,
      high:    i.high,
      low:     i.low,
      pe:      i.pe,
      pb:      i.pb,
    };
  });
  return result;
}

// ── GAINERS / LOSERS ──────────────────────────────────────────
async function getMovers() {
  try {
    const [gR, lR] = await Promise.all([
      fetchNSE('/api/live-analysis-variations?index=nifty500&dataType=gainers'),
      fetchNSE('/api/live-analysis-variations?index=nifty500&dataType=loosers'),
    ]);
    const toList = (r) => {
      if (!r.ok || !r.data) return [];
      const arr = Array.isArray(r.data?.data) ? r.data.data : Array.isArray(r.data) ? r.data : [];
      return arr.slice(0, 15).map(d => ({ symbol: d.symbol, price: d.lastPrice, pChange: d.pChange }));
    };
    return { gainers: toList(gR), losers: toList(lR) };
  } catch(e) {
    return { gainers: [], losers: [] };
  }
}

// ── RESULTS CALENDAR ──────────────────────────────────────────
async function getResultsCalendar() {
  const r = await fetchNSE('/api/event-calendar');
  if (!r.ok) return { results: [], dividends: [] };
  const today   = new Date();
  const cutoff  = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);
  const arr     = Array.isArray(r.data) ? r.data : (r.data?.data || []);
  const results   = [];
  const dividends = [];
  arr.filter(e => {
    const d = new Date(e.date || '');
    return d >= today && d <= cutoff;
  }).forEach(e => {
    const purpose = (e.purpose || '').toLowerCase();
    if (purpose.includes('result')) results.push({ symbol: e.symbol, name: e.companyName || e.symbol, date: e.date, purpose: e.purpose });
    else if (purpose.includes('dividend')) dividends.push({ symbol: e.symbol, date: e.date, purpose: e.purpose });
  });
  return { results: results.slice(0, 50), dividends: dividends.slice(0, 50) };
}

// ── YAHOO FINANCE — macro ─────────────────────────────────────
function fetchYahoo(symbols) {
  return new Promise(resolve => {
    const syms = symbols.map(s => encodeURIComponent(s)).join('%2C');
    const req = https.get({
      hostname: 'query1.finance.yahoo.com',
      path:     `/v7/finance/quote?symbols=${syms}&fields=regularMarketPrice,shortName`,
      headers:  {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Accept':          'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip',
        'Origin':          'https://finance.yahoo.com',
        'Referer':         'https://finance.yahoo.com/',
      },
      timeout: 10000,
    }, res => {
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') stream = res.pipe(zlib.createGunzip());
      let data = '';
      stream.on('data', c => data += c.toString());
      stream.on('end', () => {
        try { resolve({ ok: true, data: JSON.parse(data) }); }
        catch (e) { resolve({ ok: false, error: e.message }); }
      });
      stream.on('error', e => resolve({ ok: false, error: e.message }));
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
  });
}

// ── FETCH ALL US STOCK PRICES ─────────────────────────────────
// Yahoo Finance allows ~100 symbols per call
async function getAllUSPrices(symbols) {
  const results = {};
  const AV_KEY  = process.env.ALPHA_VANTAGE_KEY || 'KB3U5RNE551GUQUR';

  // Priority symbols — holdings + top US stocks
  const PRIORITY = ['NET','CEG','GLNG','NVDA','MSFT','AAPL','GOOGL','META',
                    'AMZN','TSLA','JPM','GS','XOM','LNG','GLD','QQQ','SPY','SOXX'];

  // Try Yahoo Finance first (fast, but sometimes blocked)
  try {
    const batchSize = 50;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch   = symbols.slice(i, i + batchSize);
      const symsStr = batch.map(s => encodeURIComponent(s)).join('%2C');
      const r = await fetchURL(
        'query2.finance.yahoo.com',
        `/v8/finance/spark?symbols=${symsStr}&range=1d&interval=1d`,
        {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
          'Accept':          'application/json',
          'Accept-Encoding': 'gzip',
          'Referer':         'https://finance.yahoo.com/',
        }
      );
      if (r.ok && r.data?.spark?.result) {
        r.data.spark.result.forEach(item => {
          const price = item?.response?.[0]?.meta?.regularMarketPrice;
          if (price && item.symbol) results[item.symbol] = price;
        });
      }
      await sleep(300);
    }
  } catch(e) {
    console.log('Yahoo batch error:', e.message);
  }

  // Fill missing priority symbols with Alpha Vantage (reliable, 25 calls/day free)
  const missing = PRIORITY.filter(s => !results[s]);
  if (missing.length > 0) {
    console.log(`Alpha Vantage filling ${missing.length} missing priority symbols...`);
    for (const sym of missing.slice(0, 18)) {
      try {
        const price = await new Promise(resolve => {
          const req = https.get({
            hostname: 'www.alphavantage.co',
            path:     `/query?function=GLOBAL_QUOTE&symbol=${sym}&apikey=${AV_KEY}`,
            headers:  { 'User-Agent': 'Mozilla/5.0' },
            timeout:  10000,
          }, res => {
            let data = '';
            res.on('data', c => data += c.toString());
            res.on('end', () => {
              try {
                const json  = JSON.parse(data);
                const price = parseFloat(json['Global Quote']?.['05. price']);
                resolve(isNaN(price) ? null : price);
              } catch { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
        });
        if (price) {
          results[sym] = price;
          console.log(`  AV: ${sym} = $${price}`);
        }
      } catch(e) {
        console.log(`  AV error ${sym}:`, e.message);
      }
      await sleep(13000); // Alpha Vantage: 5 calls/min free tier
    }
  }

  console.log(`US prices fetched: ${Object.keys(results).length}/${symbols.length}`);
  return results;
}


async function getMacro() {
  // Try multiple Yahoo endpoints
  const MACRO_SYMS = ['USDINR=X', 'BZ=F', 'GC=F', 'NET', 'CEG', 'GLNG', 'NVDA', 'MSFT'];
  
  // Endpoint 1: query2
  let r = await new Promise(resolve => {
    const syms = MACRO_SYMS.map(s => encodeURIComponent(s)).join('%2C');
    const req = https.get({
      hostname: 'query2.finance.yahoo.com',
      path:     `/v7/finance/quote?symbols=${syms}&fields=regularMarketPrice`,
      headers:  {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept':     'application/json, text/plain, */*',
        'Referer':    'https://finance.yahoo.com/',
        'Origin':     'https://finance.yahoo.com',
      },
      timeout: 10000,
    }, res => {
      let data = ''; let stream = res;
      if (res.headers['content-encoding'] === 'gzip') stream = res.pipe(zlib.createGunzip());
      stream.on('data', c => data += c.toString());
      stream.on('end', () => { try { resolve({ok:true,data:JSON.parse(data)}); } catch { resolve({ok:false}); }});
    });
    req.on('error', () => resolve({ok:false}));
    req.on('timeout', () => { req.destroy(); resolve({ok:false}); });
  });

  // Endpoint 2: query1 fallback
  if (!r.ok || !r.data?.quoteResponse?.result?.length) {
    r = await fetchYahoo(MACRO_SYMS);
  }

  const result = {};
  (r.data?.quoteResponse?.result || []).forEach(q => {
    const p = q.regularMarketPrice;
    if (!p) return;
    if (q.symbol === 'USDINR=X') result.usdInr  = p;
    if (q.symbol === 'BZ=F')     result.brent   = p;
    if (q.symbol === 'GC=F')     result.gold    = p;
    if (['NET','CEG','GLNG','NVDA','MSFT'].includes(q.symbol)) {
      if (!result.usPrices) result.usPrices = {};
      result.usPrices[q.symbol] = p;
    }
  });

  // Alpha Vantage fallback for missing priority symbols
  const AV_KEY = process.env.ALPHA_VANTAGE_KEY || 'KB3U5RNE551GUQUR';
  const PRIORITY = ['NET','CEG','GLNG'];
  const missing  = PRIORITY.filter(s => !(result.usPrices||{})[s]);

  if (missing.length > 0) {
    for (const sym of missing) {
      try {
        const avPrice = await new Promise(resolve => {
          const req = https.get({
            hostname: 'www.alphavantage.co',
            path:     `/query?function=GLOBAL_QUOTE&symbol=${sym}&apikey=${AV_KEY}`,
            headers:  { 'User-Agent': 'Mozilla/5.0' },
            timeout:  10000,
          }, res => {
            let data = '';
            res.on('data', c => data += c.toString());
            res.on('end', () => {
              try {
                const price = parseFloat(JSON.parse(data)['Global Quote']?.['05. price']);
                resolve(isNaN(price) ? null : price);
              } catch { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
        });
        if (avPrice) {
          if (!result.usPrices) result.usPrices = {};
          result.usPrices[sym] = avPrice;
          console.log(`  AV: ${sym} = $${avPrice}`);
        }
        await sleep(13000); // 5 calls/min free tier
      } catch(e) {}
    }
  }

  return result;
}



module.exports = {
  refreshCookie,
  getCookie,
  getNifty500List,
  getPriceHistory,
  getQuote,
  getBulkQuotes,
  getFII,
  getIndices,
  getMovers,
  getResultsCalendar,
  getAllUSPrices,
  getMacro,
  sleep,
};
