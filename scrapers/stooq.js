// ── STOOQ.COM PRICE HISTORY ────────────────────────────────────
// Free, no API key, works from cloud IPs
// NSE stocks: SYMBOL.NS  US stocks: SYMBOL.US
// URL: https://stooq.com/q/d/l/?s=RELIANCE.NS&i=d

'use strict';
const https  = require('https');
const zlib   = require('zlib');

// Symbol mapping — stooq uses different suffixes
function toStooqSymbol(symbol, country = 'IN') {
  // Known US symbols
  const US_SET = new Set([
    'NET','CEG','GLNG','NVDA','MSFT','AAPL','GOOGL','META','AMZN','TSLA',
    'AMD','AVGO','INTC','QCOM','MU','ASML','TSM','ARM','MRVL','CRM','NOW',
    'SNOW','DDOG','PANW','ZS','PLTR','ADBE','ORCL','WDAY','INTU','JPM',
    'GS','MS','BAC','V','MA','BLK','SPGI','COF','JNJ','UNH','ABBV','MRK',
    'PFE','TMO','ISRG','LLY','NVO','WMT','COST','MCD','NKE','SBUX','DIS',
    'NFLX','LMT','RTX','NOC','GD','HII','GE','CAT','HON','UPS','FDX',
    'XOM','CVX','COP','SLB','NEE','VST','TTE','SHEL','BP','FANG','LNG',
    'AMT','EQIX','DLR','PLD','O','GLD','SLV','NEM','FCX','LIN',
    'SPY','VOO','QQQ','SOXX','XLE','XLF','ARKK','EEM','INDA',
    'INFY','WIT','HDB','IBN','RDY','VEDL',
  ]);

  if (US_SET.has(symbol) || country === 'US') {
    return symbol.toLowerCase() + '.us';
  }

  // NSE India — use .ns suffix
  // Handle special characters
  const clean = symbol.replace('&', '%26').replace('-', '%2D');
  return clean.toLowerCase() + '.ns';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Fetch CSV from stooq
function fetchStooq(stooqSym, days = 365) {
  return new Promise(resolve => {
    const endDate   = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days - 10); // buffer

    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const path = `/q/d/l/?s=${stooqSym}&d1=${fmt(startDate)}&d2=${fmt(endDate)}&i=d`;

    const req = https.get({
      hostname: 'stooq.com',
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'text/html,application/xhtml+xml,*/*',
        'Accept-Encoding': 'gzip, deflate',
      },
      timeout: 15000,
    }, res => {
      let chunks = [];
      let stream = res;

      if (res.headers['content-encoding'] === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      }

      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        try {
          const csv = Buffer.concat(chunks.map(c =>
            typeof c === 'string' ? Buffer.from(c) : c
          )).toString('utf8');

          // Parse CSV: Date,Open,High,Low,Close,Volume
          const lines = csv.trim().split('\n');
          if (lines.length < 3) { resolve(null); return; }

          // Skip header
          const data = [];
          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            if (cols.length < 5) continue;
            const close = parseFloat(cols[4]);
            if (isNaN(close) || close <= 0) continue;
            data.push({
              date:  cols[0].trim(),
              open:  parseFloat(cols[1]) || close,
              high:  parseFloat(cols[2]) || close,
              low:   parseFloat(cols[3]) || close,
              close,
              vol:   parseInt(cols[5]) || 0,
            });
          }

          // Sort ascending (stooq returns descending)
          data.sort((a, b) => a.date.localeCompare(b.date));

          resolve(data.length >= 10 ? data : null);
        } catch(e) {
          resolve(null);
        }
      });
      stream.on('error', () => resolve(null));
    });

    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Main export — same signature as old nse.getPriceHistory
async function getPriceHistory(symbol, fromDate, toDate, days) {
  const fetchDays  = days || 365;
  const stooqSym   = toStooqSymbol(symbol);
  const history    = await fetchStooq(stooqSym, fetchDays);

  if (history && history.length >= 10) {
    return history;
  }

  // Retry with alternate suffix
  const altSym = symbol.toLowerCase() + '.bo'; // BSE fallback for India
  const alt    = await fetchStooq(altSym, fetchDays);
  return alt;
}

module.exports = { getPriceHistory, toStooqSymbol, sleep };
