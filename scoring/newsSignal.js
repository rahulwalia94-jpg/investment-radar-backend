// ═══════════════════════════════════════════════════════════════
// NEWS SIGNAL v2 — FinBERT via HuggingFace + keyword fallback
// ALL functions are ASYNC
// Returns NewsResult (see SCHEMA.js)
// ═══════════════════════════════════════════════════════════════
'use strict';

const https = require('https');
const zlib  = require('zlib');

const HF_TOKEN   = process.env.HF_TOKEN || '';
const HF_MODEL   = 'ProsusAI/finbert';
const BATCH_SIZE = 8;

// ── GEO FLAGS ─────────────────────────────────────────────────
const GEO_FLAGS = {
  TRUMP_TARIFF:  { kw:['tariff','trade war','import duty','section 301'],               impact:{US_Tech:-8, IN_IT:+5, Energy:-3} },
  TRUMP_FED:     { kw:['trump fed','powell','rate cut','federal reserve'],               impact:{Banking:+8, Realty:+6, Tech:+4} },
  IRAN_HORMUZ:   { kw:['iran','hormuz','persian gulf','lng shipping','oil tanker'],      impact:{GLNG:+15, LNG:+20, Energy:+10, CEG:+5} },
  RBI_POLICY:    { kw:['rbi','repo rate','mpc meeting','reserve bank india'],            impact:{Banking:+8, NBFC:+10, Realty:+8} },
  CHINA_SLOWDOWN:{ kw:['china gdp','china slowdown','china pmi','china recession'],     impact:{Metals:-10, Energy:-5} },
  INDIA_BUDGET:  { kw:['union budget','finance minister','capex','fiscal deficit'],     impact:{Defence:+15, Infra:+12, Realty:+8} },
  OPEC_OIL:      { kw:['opec','oil production','brent crude','crude oil cut'],          impact:{Energy:+10, GLNG:+8, Aviation:-8} },
  US_RECESSION:  { kw:['recession','gdp contraction','yield curve invert','fed pivot'], impact:{GLD:+12, TLT:+10, Tech:-10} },
};

// ── KEYWORD FALLBACK ──────────────────────────────────────────
const POS = ['beat','beats','surges','wins','record','upgrade','strong','growth','profit','contract','order','breakthrough','dividend'];
const NEG = ['miss','falls','drops','loss','weak','cut','downgrade','fraud','probe','fine','penalty','delays','layoffs','concern'];

function keywordSentiment(text) {
  const t = text.toLowerCase();
  let p = 0, n = 0;
  POS.forEach(w => { if (t.includes(w)) p++; });
  NEG.forEach(w => { if (t.includes(w)) n++; });
  return p + n > 0 ? (p - n) / (p + n) : 0;
}

// ── FINBERT API ───────────────────────────────────────────────
function callFinBERT(inputs) {
  return new Promise(resolve => {
    const body = JSON.stringify({ inputs, options:{ wait_for_model:true } });
    const req  = https.request({
      hostname: 'api-inference.huggingface.co',
      path:     `/models/${HF_MODEL}`,
      method:   'POST',
      headers: {
        Authorization:  `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, res => {
      const bufs = [];
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') stream = res.pipe(zlib.createGunzip());
      stream.on('data', c => bufs.push(c));
      stream.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(bufs).toString());
          if (!Array.isArray(data)) { resolve(null); return; }
          const scores = data.map(item => {
            if (!Array.isArray(item)) return 0;
            const pos = item.find(x => x.label==='positive')?.score || 0;
            const neg = item.find(x => x.label==='negative')?.score || 0;
            return parseFloat((pos - neg).toFixed(3));
          });
          resolve(scores);
        } catch(e) { resolve(null); }
      });
      stream.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

async function finbertBatch(texts) {
  if (!HF_TOKEN || texts.length === 0) return null;
  const all = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch  = texts.slice(i, i + BATCH_SIZE).map(t => t.slice(0, 512));
    const result = await callFinBERT(batch);
    if (!result) return null; // if any batch fails, use keyword for all
    all.push(...result);
  }
  return all;
}

// ── GEO FLAG DETECTION ────────────────────────────────────────
function detectFlags(text, symbol, sector) {
  const lower = text.toLowerCase();
  const found = [];
  Object.entries(GEO_FLAGS).forEach(([name, flag]) => {
    if (!flag.kw.some(kw => lower.includes(kw))) return;
    let impact = flag.impact[symbol] || 0;
    if (!impact && sector) {
      Object.entries(flag.impact).forEach(([k, v]) => {
        if (sector.includes(k)) impact = Math.max(Math.abs(impact), Math.abs(v)) * Math.sign(v);
      });
    }
    found.push({ flag:name, impact, note:flag.kw[0] });
  });
  return found;
}

// ── MAIN: score (ASYNC) ───────────────────────────────────────
async function score(symbol, sector, newsItems) {
  if (!newsItems || newsItems.length === 0) {
    return { score:50, sentiment:0, articles:0, flags:[], geo_impact:0, source:'no_news' };
  }

  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const items  = newsItems
    .filter(n => !n.published || new Date(n.published).getTime() > cutoff)
    .slice(0, 20);

  const texts  = items.map(n => `${n.title||''} ${n.summary||''}`.trim()).filter(Boolean);
  if (texts.length === 0) {
    return { score:50, sentiment:0, articles:0, flags:[], geo_impact:0, source:'no_items' };
  }

  // Sentiment scoring
  let sentiments = null;
  let source     = 'keyword';

  if (HF_TOKEN) {
    sentiments = await finbertBatch(texts);
    if (sentiments) source = 'finbert';
  }
  if (!sentiments) {
    sentiments = texts.map(keywordSentiment);
  }

  const avgSentiment = sentiments.reduce((s, v) => s + v, 0) / sentiments.length;

  // Geo flags
  const allText    = texts.join(' ');
  const rawFlags   = detectFlags(allText, symbol, sector);
  const seen       = new Set();
  const flags      = rawFlags.filter(f => { if(seen.has(f.flag)) return false; seen.add(f.flag); return true; });
  const geo_impact = Math.max(-20, Math.min(20, flags.reduce((s, f) => s + (f.impact||0), 0)));

  const finalScore = Math.round(Math.max(0, Math.min(100,
    50 + avgSentiment * 30 + geo_impact
  )));

  return {
    score:      finalScore,
    sentiment:  parseFloat(avgSentiment.toFixed(3)),
    articles:   items.length,
    flags,
    geo_impact,
    source,
    model:      source === 'finbert' ? HF_MODEL : 'keyword_v2',
  };
}

// ── GLOBAL GEO (for STATUS display) ──────────────────────────
function globalGeoFlags(allItems) {
  const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
  const recent = (allItems||[]).filter(n => !n.published || new Date(n.published).getTime() > cutoff);
  const active = {};
  Object.entries(GEO_FLAGS).forEach(([name, flag]) => {
    const hits = recent.filter(n => {
      const t = `${n.title||''} ${n.summary||''}`.toLowerCase();
      return flag.kw.some(kw => t.includes(kw));
    });
    if (hits.length > 0) {
      active[name] = { count:hits.length, impact:flag.impact, note:flag.kw[0], latest:hits[0]?.title?.slice(0,80) };
    }
  });
  return active;
}

// ── STATUS CHECK ──────────────────────────────────────────────
async function checkFinBERT() {
  if (!HF_TOKEN) return { available:false, reason:'No HF_TOKEN env var' };
  const result = await finbertBatch(['TCS beats quarterly estimates by 5%']);
  if (result) return { available:true, model:HF_MODEL, test_score:result[0] };
  return { available:false, reason:'HF API not responding or model loading' };
}

module.exports = { score, globalGeoFlags, checkFinBERT, keywordSentiment };
