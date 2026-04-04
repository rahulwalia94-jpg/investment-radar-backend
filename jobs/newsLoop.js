// ═══════════════════════════════════════════════════════════════
// Continuous News Loop — runs 24/7 in background
// Rotates through all 605 stocks (500 India + 105 US)
// Fetches news every 15 minutes for the next batch
// Stores in Firebase — scoring job reads freshest available
// ═══════════════════════════════════════════════════════════════
const https = require('https');
const zlib  = require('zlib');
const fb    = require('../db');
const db    = fb;  // alias for B2 db

// ── GOOGLE NEWS QUERIES ───────────────────────────────────────
// Maps stock symbol → best search query for that stock
const NEWS_QUERIES = {
  // ── INDIA IT ─────────────────────────────────────────────────
  TCS:         'TCS Tata Consultancy Services results',
  INFY:        'Infosys results earnings India',
  HCLTECH:     'HCL Technologies IT results',
  WIPRO:       'Wipro IT India results',
  PERSISTENT:  'Persistent Systems India IT',
  LTIM:        'LTIMindtree results India',
  COFORGE:     'Coforge IT India results',
  MPHASIS:     'Mphasis IT results India',
  TECHM:       'Tech Mahindra results earnings',
  KPITTECH:    'KPIT Technologies automotive',

  // ── INDIA BANKING ────────────────────────────────────────────
  HDFCBANK:    'HDFC Bank results earnings India',
  ICICIBANK:   'ICICI Bank results India',
  SBIN:        'SBI State Bank India results',
  AXISBANK:    'Axis Bank results India',
  KOTAKBANK:   'Kotak Mahindra Bank results',
  BAJFINANCE:  'Bajaj Finance NBFC results',
  INDUSINDBK:  'IndusInd Bank results India',
  FEDERALBNK:  'Federal Bank results India',
  IDFCFIRSTB:  'IDFC First Bank results',

  // ── INDIA DEFENCE ────────────────────────────────────────────
  HAL:         'HAL Hindustan Aeronautics defence order',
  BEL:         'BEL Bharat Electronics defence',
  COCHINSHIP:  'Cochin Shipyard defence order',
  GRSE:        'Garden Reach Shipbuilders defence',
  MIDHANI:     'Midhani defence materials',
  BHARATFORG:  'Bharat Forge defence forging',

  // ── INDIA PHARMA ─────────────────────────────────────────────
  SUNPHARMA:   'Sun Pharma results earnings India',
  DRREDDY:     'Dr Reddy results India pharma',
  CIPLA:       'Cipla pharma results India',
  DIVISLAB:    'Divi Laboratories results',
  LUPIN:       'Lupin pharma results India',
  TORNTPHARM:  'Torrent Pharma results India',
  AUROPHARMA:  'Aurobindo Pharma results',

  // ── INDIA FMCG ───────────────────────────────────────────────
  HINDUNILVR:  'HUL Hindustan Unilever results India',
  ITC:         'ITC results cigarette FMCG India',
  NESTLEIND:   'Nestle India results FMCG',
  BRITANNIA:   'Britannia results India FMCG',
  MARICO:      'Marico results FMCG India',
  DABUR:       'Dabur results FMCG India',

  // ── INDIA ENERGY ─────────────────────────────────────────────
  RELIANCE:    'Reliance Industries results earnings',
  ONGC:        'ONGC results oil India',
  COALINDIA:   'Coal India results production',
  NTPC:        'NTPC power results India',
  POWERGRID:   'Power Grid India results',
  ADANIGREEN:  'Adani Green Energy results',

  // ── INDIA AUTO ───────────────────────────────────────────────
  MARUTI:      'Maruti Suzuki sales results India',
  TATAMOTORS:  'Tata Motors results EV India',
  HEROMOTOCO:  'Hero MotoCorp sales results',
  EICHERMOT:   'Eicher Motors Royal Enfield results',
  TVSMOTOR:    'TVS Motor results India',

  // ── INDIA INFRA/CAPITAL GOODS ────────────────────────────────
  LT:          'Larsen Toubro L&T results order',
  ADANIPORTS:  'Adani Ports results India',
  IRCTC:       'IRCTC results railway India',
  IRFC:        'IRFC results railway finance',
  BHARTIARTL:  'Airtel results telecom India',

  // ── INDIA METALS ─────────────────────────────────────────────
  TATASTEEL:   'Tata Steel results earnings',
  JSWSTEEL:    'JSW Steel results India',
  HINDALCO:    'Hindalco results aluminium',
  VEDL:        'Vedanta results metals India',

  // ── US TECH ──────────────────────────────────────────────────
  NET:         'Cloudflare results earnings cybersecurity',
  NVDA:        'Nvidia results AI chips earnings',
  MSFT:        'Microsoft results earnings AI',
  AAPL:        'Apple results earnings iPhone',
  GOOGL:       'Google Alphabet results earnings',
  META:        'Meta results earnings social media',
  AMZN:        'Amazon results earnings AWS',
  TSLA:        'Tesla results deliveries earnings',
  AMD:         'AMD results earnings chips',
  PLTR:        'Palantir results earnings AI',

  // ── US DEFENCE ───────────────────────────────────────────────
  LMT:         'Lockheed Martin results defence contract',
  RTX:         'Raytheon RTX results defence',
  NOC:         'Northrop Grumman results defence',
  GD:          'General Dynamics results defence',

  // ── US HEALTHCARE ────────────────────────────────────────────
  JNJ:         'Johnson Johnson results earnings healthcare',
  UNH:         'UnitedHealth results earnings insurance',
  LLY:         'Eli Lilly results GLP-1 earnings',

  // ── US ENERGY ────────────────────────────────────────────────
  CEG:         'Constellation Energy results nuclear',
  GLNG:        'Golar LNG results shipping earnings',
  XOM:         'ExxonMobil results oil earnings',
  CVX:         'Chevron results earnings oil',

  // ── US CONSUMER ──────────────────────────────────────────────
  WMT:         'Walmart results earnings retail',
  COST:        'Costco results earnings retail',

  // ── COMMODITIES & MACRO ──────────────────────────────────────
  'GLD':       'gold price rally safe haven',
  'GC=F':      'gold futures price outlook',
  'SLV':       'silver price rally metals',
  'CL=F':      'crude oil WTI price OPEC',
  'BZ=F':      'brent crude oil price outlook',
  'NG=F':      'natural gas price LNG',
  'TLT':       'US treasury bonds yield rally',
  'IEF':       'US treasury bonds 10 year yield',
  'HYG':       'high yield bonds credit spread',
  'BTC-USD':   'bitcoin price crypto rally',
  'ETH-USD':   'ethereum price crypto',
  '^VIX':      'VIX volatility fear market crash',
  '^TNX':      'US 10 year treasury yield rates Fed',
  'USDINR=X':  'USD INR rupee dollar exchange rate RBI',
  'DX-Y.NYB':  'dollar index DXY strength rally',

  // ── ADDITIONAL INDIA STOCKS ──────────────────────────────────
  TITAN:       'Titan results jewellery India',
  TRENT:       'Trent Zara retail results India',
  DMART:       'DMart Avenue Supermarts results',
  BAJAJFINSV:  'Bajaj Finserv results insurance',
  CHOLAFIN:    'Cholamandalam Finance results NBFC',
  SHRIRAMFIN:  'Shriram Finance results NBFC',
  MUTHOOTFIN:  'Muthoot Finance gold loan results',
  APOLLOHOSP:  'Apollo Hospitals results healthcare',
  MAXHEALTH:   'Max Healthcare results India',
  FORTIS:      'Fortis Healthcare results India',
  ULTRACEMCO:  'UltraTech Cement results India',
  AMBUJACEM:   'Ambuja Cement results India',
  SHREECEM:    'Shree Cement results India',
  PIIND:       'PI Industries results agrochemical',
  UPL:         'UPL results agrochemical India',
  SIEMENS:     'Siemens India results capital goods',
  ABB:         'ABB India results capital goods',
  HAVELLS:     'Havells results electrical India',
  POLYCAB:     'Polycab results cables India',
  ZOMATO:      'Zomato results food delivery India',
  NAUKRI:      'Info Edge Naukri results India',
  PAYTM:       'Paytm results fintech India',
  DLF:         'DLF results real estate India',
  GODREJPROP:  'Godrej Properties results India',
  OBEROIRLTY:  'Oberoi Realty results India',
  HDFCLIFE:    'HDFC Life insurance results India',
  SBILIFE:     'SBI Life insurance results India',
  ICICIPRULI:  'ICICI Prudential Life results',
  GAIL:        'GAIL India gas results',
  IOC:         'Indian Oil results refinery India',
  BPCL:        'BPCL Bharat Petroleum results',
  HINDPETRO:   'HPCL Hindustan Petroleum results',
  CONCOR:      'Container Corporation results India',

  // ── US FINANCE ───────────────────────────────────────────────
  JPM:         'JPMorgan Chase results earnings bank',
  GS:          'Goldman Sachs results earnings bank',
  MS:          'Morgan Stanley results earnings',
  BAC:         'Bank of America results earnings',
  V:           'Visa results earnings payments',
  MA:          'Mastercard results earnings payments',

  // ── COMMODITIES ADDITIONAL ───────────────────────────────────
  'ALI=F':     'aluminium price rally metals LME',
  'HG=F':      'copper price rally China demand',
  'ZW=F':      'wheat price food commodity Ukraine',
  'ZC=F':      'corn price food commodity USDA',
  'TIP':       'TIPS inflation bonds Fed rate',
  'SHY':       'short term treasury bonds cash',
  'LQD':       'investment grade corporate bonds credit',
  'SOXX':      'semiconductor ETF chip stocks',
  'QQQ':       'Nasdaq 100 tech stocks rally',
  'EEM':       'emerging markets ETF EM rally',
  'INDA':      'India ETF Modi economy growth',
  'XLE':       'energy sector ETF oil stocks',
  'SOL-USD':   'solana price crypto blockchain',
  'ETH-USD':   'ethereum price DeFi crypto',
};

// ── FETCH GOOGLE NEWS ─────────────────────────────────────────
function fetchGoogleNews(query, maxItems = 4) {
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'news.google.com',
      path:     `/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`,
      method:   'GET',
      headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml' },
      timeout:  8000,
    }, res => {
      let data   = '';
      let stream = res;
      const enc  = res.headers['content-encoding'];
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      stream.on('data', c => data += c.toString());
      stream.on('end', () => {
        const items = [];
        const rx    = /<item>([\s\S]*?)<\/item>/g;
        let m;
        while ((m = rx.exec(data)) !== null && items.length < maxItems) {
          const title = (/<title>([\s\S]*?)<\/title>/.exec(m[1]) || [])[1] || '';
          const date  = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(m[1]) || [])[1] || '';
          const clean = title
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"')
            .trim();
          if (clean && !clean.startsWith('Google News')) {
            items.push({ title: clean, date: date.trim(), fetched_at: new Date().toISOString() });
          }
        }
        resolve({ ok: true, items });
      });
      stream.on('error', e => resolve({ ok: false, items: [], error: e.message }));
    });
    req.on('error', e => resolve({ ok: false, items: [], error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, items: [], error: 'TIMEOUT' }); });
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── CONTINUOUS NEWS LOOP STATE ────────────────────────────────
let newsLoopRunning    = false;
let currentBatchIndex  = 0;
let totalNewsUpdates   = 0;
let lastLoopStats      = null;

const ALL_SYMBOLS      = Object.keys(NEWS_QUERIES);
const BATCH_SIZE       = 25;   // 25 stocks per cycle
const DELAY_BETWEEN    = 300;  // 300ms between queries (safe for Google)
const CYCLE_INTERVAL   = 15 * 60 * 1000; // 15 min between batches

// ── SCORE SENTIMENT WITH HAIKU ───────────────────────────────
async function scoreSentiment(symbol, headlines) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt    = `Score each headline -3 to +3 for ${symbol} stock price impact.
-3=very negative, 0=neutral, +3=very positive.
Return ONLY JSON: {"scores":[{"title":"...","sentiment":1.5,"event_weight":1.0}]}

Headlines:
${headlines.map((h,i) => `${i+1}. ${h.title}`).join('\n')}`;

    const res    = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const text   = res.content[0]?.text || '';
    const clean  = text.replace(/\`\`\`json\n?/g,'').replace(/\`\`\`\n?/g,'').trim();
    const parsed = JSON.parse(clean.match(/\{[\s\S]*\}/)?.[0] || '{}');
    return parsed.scores || [];
  } catch(e) {
    return headlines.map(h => ({ title: h.title, sentiment: 0, event_weight: 1.0 }));
  }
}

// ── FETCH ONE BATCH ───────────────────────────────────────────
async function fetchNewsBatch(symbols) {
  const results = {};
  const errors  = [];

  for (const symbol of symbols) {
    const query = NEWS_QUERIES[symbol];
    if (!query) continue;

    try {
      const r = await fetchGoogleNews(query, 4);
      if (r.ok && r.items.length > 0) {
        // Score sentiment at fetch time (cheap — one Haiku call per stock)
        const scored = await scoreSentiment(symbol, r.items);
        // Merge sentiment into items
        const items  = r.items.map((item, i) => ({
          ...item,
          sentiment:    scored[i]?.sentiment    ?? 0,
          event_weight: scored[i]?.event_weight ?? 1.0,
          fetched_at:   new Date().toISOString(),
        }));
        results[symbol] = items;
        await sleep(100); // small delay after Haiku call
      }
    } catch (e) {
      errors.push(symbol);
    }

    await sleep(DELAY_BETWEEN);
  }

  return { results, errors };
}

// ── SAVE NEWS BATCH TO FIREBASE ───────────────────────────────
async function saveNewsBatch(results) {
  try {
    const existing = await db.getLatestNews() || { stocks: {}, market: [], updated_at: null };
    if (!existing.stocks) existing.stocks = {};
    
    // results can be object {symbol: data} or array [{symbol, items}]
    if (Array.isArray(results)) {
      results.forEach(r => {
        if (!r || !r.symbol) return;
        existing.stocks[r.symbol] = {
          items:      (r.items || []).slice(0, 10),
          sentiment:  r.sentiment,
          updated_at: new Date().toISOString(),
        };
      });
    } else {
      Object.entries(results).forEach(([sym, data]) => {
        existing.stocks[sym] = {
          items:      (data.items || []).slice(0, 10),
          sentiment:  data.sentiment,
          updated_at: new Date().toISOString(),
        };
      });
    }
    
    existing.updated_at = new Date().toISOString();
    await db.saveNews(existing);
  } catch(e) {
    console.error('saveNewsBatch error:', e.message);
  }
}

// ── GET NEWS FOR STOCK (used by scoring engine) ───────────────
async function getStockNews(symbol) {
  try {
      const newsData = await db.getLatestNews() || {};
    const doc = { exists: !!(newsData.stocks?.[symbol]), data: () => newsData.stocks?.[symbol] || {} };
    return doc.exists ? doc.data() : null;
  } catch (e) {
    return null;
  }
}

// ── GET NEWS FOR MULTIPLE STOCKS ──────────────────────────────
async function getStockNewsMultiple(symbols) {
  try {
      const results = {};

    // Batch get — Firestore allows 10 at a time
    const batchSize = 10;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      await Promise.all(batch.map(async (symbol) => {
        const newsData = await db.getLatestNews() || {};
    const doc = { exists: !!(newsData.stocks?.[symbol]), data: () => newsData.stocks?.[symbol] || {} };
        if (doc.exists) results[symbol] = doc.data().items || [];
      }));
    }

    return results;
  } catch (e) {
    console.error('getStockNewsMultiple error:', e.message);
    return {};
  }
}

// ── GET ALL RECENT NEWS (for market summary) ──────────────────
async function getMarketNews() {
  try {
      const newsData2 = await db.getLatestNews() || {};
  const doc = { exists: !!(newsData2.market), data: () => ({ items: newsData2.market || [] }) };
    return doc.exists ? doc.data().items || [] : [];
  } catch (e) {
    return [];
  }
}

// ── FETCH MARKET NEWS (Nifty, FII, macro) ────────────────────
async function fetchMarketNews() {
  const queries = [
    'NSE Nifty market India today',
    'FII DII India stock market today',
    'RBI rate India inflation today',
    'Fed Federal Reserve rate today',
    'Iran war oil Hormuz LNG today',
    'India GDP inflation rupee today',
  ];

  const allItems = [];
  for (const q of queries) {
    const r = await fetchGoogleNews(q, 3);
    if (r.ok) allItems.push(...r.items);
    await sleep(300);
  }

  // Deduplicate
  const seen  = new Set();
  const dedup = allItems.filter(item => {
    const key = item.title.slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);

  // Save to Firebase
  const existing2 = await db.getLatestNews() || {};
  await db.saveNews({ ...existing2, market: dedup, market_updated_at: new Date().toISOString() });

  return dedup;
}

// ── NEWS LOOP STATUS ──────────────────────────────────────────
function getNewsLoopStatus() {
  const totalBatches   = Math.ceil(ALL_SYMBOLS.length / BATCH_SIZE);
  const pctComplete    = Math.round((currentBatchIndex / ALL_SYMBOLS.length) * 100);
  const cycleTimeHours = (ALL_SYMBOLS.length / BATCH_SIZE * CYCLE_INTERVAL / 3600000).toFixed(1);

  return {
    running:          newsLoopRunning,
    total_stocks:     ALL_SYMBOLS.length,
    current_index:    currentBatchIndex,
    pct_complete:     pctComplete,
    total_updates:    totalNewsUpdates,
    cycle_time_hours: cycleTimeHours,
    last_stats:       lastLoopStats,
    batch_size:       BATCH_SIZE,
    delay_ms:         DELAY_BETWEEN,
    cycle_interval_min: CYCLE_INTERVAL / 60000,
  };
}

// ── START THE CONTINUOUS LOOP ─────────────────────────────────
async function startNewsLoop() {
  if (newsLoopRunning) {
    console.log('News loop already running');
    return;
  }

  newsLoopRunning = true;
  console.log(`\n📰 News loop started — ${ALL_SYMBOLS.length} stocks, batches of ${BATCH_SIZE}`);
  console.log(`   Full rotation every ~${(ALL_SYMBOLS.length / BATCH_SIZE * CYCLE_INTERVAL / 3600000).toFixed(1)} hours`);

  // Also immediately fetch market news
  fetchMarketNews().then(items => {
    console.log(`Market news fetched: ${items.length} items`);
  }).catch(console.error);

  const loop = async () => {
    while (newsLoopRunning) {
      try {
        // Get next batch of symbols
        const batchSymbols = ALL_SYMBOLS.slice(currentBatchIndex, currentBatchIndex + BATCH_SIZE);

        if (batchSymbols.length === 0) {
          // Full rotation complete — restart from beginning
          currentBatchIndex = 0;
          console.log(`\n📰 News loop: full rotation complete (${totalNewsUpdates} total updates)`);

          // Refresh market news on each full rotation
          fetchMarketNews().catch(console.error);

          lastLoopStats = {
            completed_at:  new Date().toISOString(),
            total_updates: totalNewsUpdates,
          };

          await sleep(CYCLE_INTERVAL);
          continue;
        }

        // Fetch news for this batch
        const { results, errors } = await fetchNewsBatch(batchSymbols);

        // Save to Firebase
        if (Object.keys(results).length > 0) {
          await saveNewsBatch(results);
          totalNewsUpdates += Object.keys(results).length;
        }

        currentBatchIndex += BATCH_SIZE;

        console.log(`📰 News batch: ${currentBatchIndex}/${ALL_SYMBOLS.length} | ` +
          `fetched: ${Object.keys(results).length} | errors: ${errors.length}`);

        // Wait before next batch
        await sleep(CYCLE_INTERVAL);

      } catch (e) {
        console.error('News loop error:', e.message);
        await sleep(60000); // wait 1 min on error then retry
      }
    }
  };

  // Run loop without blocking
  loop().catch(e => {
    console.error('News loop crashed:', e.message);
    newsLoopRunning = false;
  });
}

function stopNewsLoop() {
  newsLoopRunning = false;
  console.log('News loop stopped');
}

module.exports = {
  startNewsLoop,
  stopNewsLoop,
  getNewsLoopStatus,
  fetchMarketNews,
  getStockNews,
  getStockNewsMultiple,
  getMarketNews,
  NEWS_QUERIES,
  ALL_SYMBOLS,
};
