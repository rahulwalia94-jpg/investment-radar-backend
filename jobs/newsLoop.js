// ═══════════════════════════════════════════════════════════════
// Continuous News Loop — runs 24/7 in background
// Rotates through all 605 stocks (500 India + 105 US)
// Fetches news every 15 minutes for the next batch
// Stores in Firebase — scoring job reads freshest available
// ═══════════════════════════════════════════════════════════════
const https = require('https');
const zlib  = require('zlib');
const fb    = require('../db');

// ── GOOGLE NEWS QUERIES ───────────────────────────────────────
// Maps stock symbol → best search query for that stock
const NEWS_QUERIES = {
  // India stocks — use company name for better results
  TCS:        'TCS Tata Consultancy Services',
  INFY:       'Infosys results earnings',
  HCLTECH:    'HCL Technologies IT India',
  WIPRO:      'Wipro IT India results',
  PERSISTENT: 'Persistent Systems India IT',
  LTIM:       'LTIMindtree results India',
  COFORGE:    'Coforge IT India results',
  SUNPHARMA:  'Sun Pharma FDA results India',
  DRREDDY:    'Dr Reddys Laboratories India pharma',
  CIPLA:      'Cipla pharma India results',
  DIVISLAB:   'Divis Laboratories India pharma',
  ICICIBANK:  'ICICI Bank India results',
  HDFCBANK:   'HDFC Bank India results',
  KOTAKBANK:  'Kotak Mahindra Bank India',
  SBIN:       'SBI State Bank India results',
  AXISBANK:   'Axis Bank India results',
  BAJFINANCE: 'Bajaj Finance India NBFC',
  HAL:        'HAL Hindustan Aeronautics defence India',
  BEL:        'BEL Bharat Electronics defence India',
  COCHINSHIP: 'Cochin Shipyard defence India',
  BHARATFORG: 'Bharat Forge defence forging India',
  MARUTI:     'Maruti Suzuki India auto sales',
  TATAMOTORS: 'Tata Motors India EV sales',
  MM:         'Mahindra Mahindra India auto',
  HEROMOTOCO: 'Hero MotoCorp India two wheeler',
  HINDUNILVR: 'Hindustan Unilever India FMCG',
  ITC:        'ITC India FMCG cigarette',
  TITAN:      'Titan India jewellery watches',
  TRENT:      'Trent Zara India retail',
  VBL:        'Varun Beverages India Pepsi',
  LT:         'Larsen Toubro India infrastructure',
  NTPC:       'NTPC India power electricity',
  POWERGRID:  'Power Grid India transmission',
  DIXON:      'Dixon Technologies India electronics',
  POLYCAB:    'Polycab India cables electrical',
  ONGC:       'ONGC India oil gas production',
  RELIANCE:   'Reliance Industries India results',
  COALINDIA:  'Coal India production results',
  BHARTIARTL: 'Bharti Airtel India telecom 5G',
  DLF:        'DLF India real estate',
  ADANIPORTS: 'Adani Ports India logistics',
  BAJAJFINSV: 'Bajaj Finserv India insurance',
  TATASTEEL:  'Tata Steel India metals',
  JSWSTEEL:   'JSW Steel India results',
  HINDALCO:   'Hindalco India aluminium',
  GOLDBEES:   'Gold ETF India price',
  INDIGO:     'IndiGo India airline results',
  INDHOTEL:   'Indian Hotels Taj India',
  DEEPAKNTR:  'Deepak Nitrite India chemicals',
  PIDILITIND: 'Pidilite Industries India Fevicol',
  ABBOTTINDIA:'Abbott India pharma results',
  NESTLEIND:  'Nestle India FMCG results',
  BRITANNIA:  'Britannia India biscuits results',
  SIEMENS:    'Siemens India industrial',
  ABB:        'ABB India industrial automation',
  CUMMINSIND: 'Cummins India engines results',
  MPHASIS:    'Mphasis India IT results',
  CYIENT:     'Cyient India engineering IT',
  KPITTECH:   'KPIT Technologies India auto IT',
  MTARTECH:   'MTAR Technologies India defence',
  GRSE:       'Garden Reach Shipbuilders India',
  PARASDEF:   'Paras Defence India',
  BAJAJ_AUTO: 'Bajaj Auto India two wheeler',
  TVSMOTOR:   'TVS Motor India two wheeler',
  EICHERMOT:  'Eicher Motors Royal Enfield India',
  MARICO:     'Marico India FMCG',
  DABUR:      'Dabur India FMCG Ayurveda',
  ULTRACEMCO: 'UltraTech Cement India results',
  KEC:        'KEC International India power',
  INDUSINDBK: 'IndusInd Bank India results',
  BANKBARODA: 'Bank of Baroda India results',
  FEDERALBNK: 'Federal Bank India results',
  SHRIRAMFIN: 'Shriram Finance India NBFC',
  APTUS:      'Aptus Value Housing India',
  NHPC:       'NHPC India hydro power',
  GAIL:       'GAIL India gas pipeline',
  IOC:        'Indian Oil Corporation India',
  WAAREEENER: 'Waaree Energies India solar',
  INDUSTOWER: 'Indus Towers India telecom',
  DELHIVERY:  'Delhivery India logistics',
  CONCOR:     'Container Corporation India logistics',
  BLUEDART:   'Blue Dart India courier',
  VEDL:       'Vedanta India mining results',
  HDFCLIFE:   'HDFC Life Insurance India',
  SBILIFE:    'SBI Life Insurance India',
  CDSL:       'CDSL India depository',
  EMBASSY:    'Embassy REIT India office',
  SILVERBEES: 'Silver ETF India price',
  OBEROIRLTY: 'Oberoi Realty India',
  PRESTIGE:   'Prestige Estates India real estate',
  GODREJPROP: 'Godrej Properties India',
  MAXHEALTH:  'Max Healthcare India hospital',
  NAVIN:      'Navin Fluorine India specialty chemicals',
  AARTIIND:   'Aarti Industries India chemicals',
  CLEAN:      'Clean Science India chemicals',
  SRF:        'SRF India chemicals fluoropolymers',
  TORNTPHARM: 'Torrent Pharma India results',
  LUPIN:      'Lupin India pharma FDA',
  PIIND:      'PI Industries India agrochemical',

  // US stocks — use ticker + company name
  NVDA:  'Nvidia stock earnings AI chips',
  MSFT:  'Microsoft Azure AI earnings',
  AAPL:  'Apple iPhone earnings results',
  GOOGL: 'Alphabet Google AI search earnings',
  META:  'Meta Facebook AI earnings',
  AMZN:  'Amazon AWS earnings results',
  TSLA:  'Tesla EV deliveries earnings',
  AMD:   'AMD AI chips data center earnings',
  AVGO:  'Broadcom AI networking earnings',
  INTC:  'Intel foundry earnings results',
  QCOM:  'Qualcomm Snapdragon earnings',
  MU:    'Micron HBM memory AI earnings',
  AMAT:  'Applied Materials semiconductor equipment',
  LRCX:  'Lam Research semiconductor earnings',
  ASML:  'ASML EUV lithography earnings',
  TSM:   'TSMC Taiwan semiconductor earnings',
  ARM:   'Arm Holdings chip IP earnings',
  MRVL:  'Marvell Technology AI chips earnings',
  CRM:   'Salesforce AI CRM earnings',
  NOW:   'ServiceNow AI workflows earnings',
  SNOW:  'Snowflake data cloud earnings',
  DDOG:  'Datadog AI monitoring earnings',
  NET:   'Cloudflare edge AI network earnings',
  PANW:  'Palo Alto Networks cybersecurity earnings',
  ZS:    'Zscaler cloud security earnings',
  PLTR:  'Palantir AI analytics earnings',
  ADBE:  'Adobe Firefly AI creative earnings',
  ORCL:  'Oracle cloud AI earnings',
  CEG:   'Constellation Energy nuclear power AI',
  GLNG:  'Golar LNG FLNG Iran Hormuz',
  LNG:   'Cheniere Energy LNG export earnings',
  XOM:   'ExxonMobil oil earnings results',
  CVX:   'Chevron oil gas earnings',
  COP:   'ConocoPhillips oil E&P earnings',
  SLB:   'SLB Schlumberger oil services earnings',
  NEE:   'NextEra Energy renewable solar earnings',
  VST:   'Vistra Energy nuclear power earnings',
  TTE:   'TotalEnergies LNG oil earnings',
  SHEL:  'Shell LNG FLNG oil earnings',
  BP:    'BP oil energy earnings',
  FANG:  'Diamondback Energy Permian oil',
  JPM:   'JPMorgan Chase earnings banking',
  GS:    'Goldman Sachs earnings investment bank',
  MS:    'Morgan Stanley wealth earnings',
  BAC:   'Bank of America earnings results',
  V:     'Visa payments earnings results',
  MA:    'Mastercard payments earnings',
  BRKB:  'Berkshire Hathaway Buffett results',
  BLK:   'BlackRock asset management earnings',
  SPGI:  'S&P Global ratings data earnings',
  COF:   'Capital One credit card earnings',
  LLY:   'Eli Lilly GLP-1 Mounjaro earnings',
  NVO:   'Novo Nordisk Ozempic GLP-1 earnings',
  JNJ:   'Johnson Johnson medtech pharma earnings',
  UNH:   'UnitedHealth insurance earnings',
  ABBV:  'AbbVie Skyrizi Rinvoq earnings',
  MRK:   'Merck Keytruda cancer earnings',
  PFE:   'Pfizer pharma pipeline earnings',
  TMO:   'Thermo Fisher life science earnings',
  ISRG:  'Intuitive Surgical da Vinci robot earnings',
  WMT:   'Walmart retail earnings results',
  COST:  'Costco warehouse retail earnings',
  MCD:   'McDonalds fast food earnings',
  NKE:   'Nike shoes apparel earnings',
  SBUX:  'Starbucks coffee earnings',
  DIS:   'Disney streaming parks earnings',
  NFLX:  'Netflix streaming subscribers earnings',
  LMT:   'Lockheed Martin defence F-35 earnings',
  RTX:   'RTX Raytheon missiles defence earnings',
  NOC:   'Northrop Grumman B-21 defence earnings',
  GD:    'General Dynamics defence IT earnings',
  HII:   'Huntington Ingalls Navy shipbuilding earnings',
  GE:    'GE Aerospace jet engine earnings',
  CAT:   'Caterpillar heavy machinery earnings',
  HON:   'Honeywell industrial automation earnings',
  UPS:   'UPS logistics parcel earnings',
  FDX:   'FedEx freight logistics earnings',
  AMT:   'American Tower REIT 5G earnings',
  PLD:   'Prologis industrial REIT earnings',
  EQIX:  'Equinix data center REIT earnings',
  DLR:   'Digital Realty data center earnings',
  O:     'Realty Income REIT dividend',
  GLD:   'Gold price ETF news',
  SLV:   'Silver price ETF news',
  NEM:   'Newmont gold mining earnings',
  FCX:   'Freeport copper mining earnings',
  LIN:   'Linde industrial gases earnings',
  SPY:   'S&P 500 market news today',
  QQQ:   'Nasdaq 100 tech market news',
  SOXX:  'Semiconductor stocks AI chips news',
  XLE:   'Energy stocks oil gas news',
  EEM:   'Emerging markets India China news',
  INDA:  'India stock market ETF NSE news',
  INFY:  'Infosys ADR earnings India IT',
  WIT:   'Wipro ADR India IT',
  HDB:   'HDFC Bank ADR India',
  IBN:   'ICICI Bank ADR India',
  RDY:   'Dr Reddys ADR India pharma',
  VEDL:  'Vedanta ADR India mining',
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
  if (Object.keys(results).length === 0) return;

  // Save each stock's news to Firebase
  // Using merge so we don't overwrite other stocks
  const db      = fb.init();
  const batch   = db.batch();
  const now     = new Date().toISOString();

  Object.entries(results).forEach(([symbol, items]) => {
    const ref = db.collection('news').doc('stocks').collection('by_symbol').doc(symbol);
    batch.set(ref, {
      symbol,
      items,
      fetched_at: now,
      count:      items.length,
    });
  });

  await batch.commit();

  // Also update the consolidated news index
  // (used by scoring engine to quickly check which stocks have news)
  const indexRef = db.collection('news').doc('stock_index');
  const updates  = {};
  Object.entries(results).forEach(([symbol, items]) => {
    updates[symbol] = {
      has_news:   true,
      count:      items.length,
      latest:     items[0]?.title?.slice(0, 80) || '',
      fetched_at: now,
    };
  });

  await indexRef.set(updates, { merge: true });
}

// ── GET NEWS FOR STOCK (used by scoring engine) ───────────────
async function getStockNews(symbol) {
  try {
    const db  = fb.init();
    const doc = await db.collection('news').doc('stocks').collection('by_symbol').doc(symbol).get();
    return doc.exists ? doc.data() : null;
  } catch (e) {
    return null;
  }
}

// ── GET NEWS FOR MULTIPLE STOCKS ──────────────────────────────
async function getStockNewsMultiple(symbols) {
  try {
    const db      = fb.init();
    const results = {};

    // Batch get — Firestore allows 10 at a time
    const batchSize = 10;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      await Promise.all(batch.map(async (symbol) => {
        const doc = await db.collection('news').doc('stocks').collection('by_symbol').doc(symbol).get();
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
    const db  = fb.init();
    const doc = await db.collection('news').doc('market').get();
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
  const db = fb.init();
  await db.collection('news').doc('market').set({
    items:      dedup,
    fetched_at: new Date().toISOString(),
    count:      dedup.length,
  });

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
