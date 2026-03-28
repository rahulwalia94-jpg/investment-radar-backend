// ═══════════════════════════════════════════════════════════════
// Investment Radar Pro — Backend Server Phase 3
// Firebase-first, Nifty 500, fully dynamic, all Haiku
// ═══════════════════════════════════════════════════════════════
const http = require('http');
const url  = require('url');
const fb   = require('./db');
const { runMorningRefresh, runMiddayUpdate, runEveningSummary } = require('./jobs/morningRefresh');
const { runWeeklyRecalibration } = require('./jobs/weeklyRecalibration');
const { startNewsLoop, stopNewsLoop, getNewsLoopStatus } = require('./jobs/newsLoop');
const fcm = require('./fcm');
const tg  = require('./telegram');

const PORT = process.env.PORT || 3000;

// ── SCHEDULE (UTC) ────────────────────────────────────────────
// IST = UTC+5:30
const SCHEDULE = [
  { utcH: 3,  utcM: 30, label: '9:00 AM IST India Open',    job: 'morning'        },
  { utcH: 6,  utcM: 30, label: '12:00 PM IST India Midday', job: 'midday'         },
  { utcH: 9,  utcM: 30, label: '3:00 PM IST India Close',   job: 'midday'         },
  { utcH: 13, utcM: 30, label: '7:00 PM IST US Open',       job: 'midday'         },
  { utcH: 16, utcM: 30, label: '10:00 PM IST US Midday',    job: 'evening'        },
  { utcH: 20, utcM: 0,  label: '1:30 AM IST US Close',      job: 'midday'         },
  { utcH: 20, utcM: 30, label: '2:00 AM IST Sunday Recal',  job: 'recalibration', dayOfWeek: 0 },
];

let nextRefreshLabel = 'calculating...';

function scheduleNext() {
  const now        = new Date();
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const dayOfWeek  = now.getUTCDay();

  let nextSlot = null;
  let minDelay = Infinity;

  for (const slot of SCHEDULE) {
    // Skip recalibration if not Sunday
    if (slot.job === 'recalibration' && slot.dayOfWeek !== dayOfWeek && slot.dayOfWeek !== (dayOfWeek + 1) % 7) continue;

    const slotMinutes = slot.utcH * 60 + slot.utcM;
    let delay = slotMinutes - nowMinutes;
    if (delay <= 0) delay += 24 * 60;
    if (delay < minDelay) { minDelay = delay; nextSlot = slot; }
  }

  if (!nextSlot) { scheduleNext(); return; }

  nextRefreshLabel = `${nextSlot.label} in ${minDelay}min`;
  console.log(`\n⏰ Next: ${nextSlot.label} in ${minDelay}min`);

  setTimeout(async () => {
    console.log(`\n🚀 Running: ${nextSlot.label}`);
    try {
      if (nextSlot.job === 'morning')        await runMorningRefresh();
      else if (nextSlot.job === 'midday')    await runMiddayUpdate();
      else if (nextSlot.job === 'evening')   await runEveningSummary();
      else if (nextSlot.job === 'recalibration') await runWeeklyRecalibration();
    } catch (e) {
      console.error(`Job error (${nextSlot.job}):`, e.message);
    }
    scheduleNext();
  }, minDelay * 60 * 1000);
}

// ── JSON RESPONSE ─────────────────────────────────────────────
function send(res, data, status = 200) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c.toString());
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

// ── SERVER ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.writeHead(204); return res.end();
  }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query    = parsed.query;

  console.log(new Date().toISOString().slice(11, 19), req.method, pathname);

  try {
    // ── HEALTH ──────────────────────────────────────────────
    if (pathname === '/' || pathname === '/health') {
      const snap = await fb.getLatestSnapshot();
      const cal  = await fb.getLastCalibration();
      const ageMin = snap?.ts ? Math.round((Date.now() - new Date(snap.ts).getTime()) / 60000) : null;
      return send(res, {
        ok:                  true,
        version:             'v6-quant-engine',
        snapshot_label:      snap?.label,
        snapshot_age_minutes:ageMin,
        regime:              snap?.regime,
        fii_net:             snap?.fii?.fii_net,
        last_calibration:    cal?.completed_at,
        instruments_calibrated: cal?.calibrated,
        next_refresh:        nextRefreshLabel,
        uptime_sec:          Math.round(process.uptime()),
        python_engine:       (() => { try { require('child_process').execSync('python3 --version', {timeout:3000}); return 'available'; } catch(e) { return 'not_found'; } })(),
        quant_model:         snap?.model || 'haiku-fallback',
        schedule:            SCHEDULE.map(s => `${s.utcH}:${String(s.utcM).padStart(2,'0')} UTC — ${s.label}`),
      });
    }

    // ── FULL SNAPSHOT for dashboard ──────────────────────────
    if (pathname === '/api/snapshot') {
      const [snap, analysis, news] = await Promise.all([
        fb.getLatestSnapshot(),
        fb.getLatestAIAnalysis(),
        fb.getLatestNews(),
      ]);
      if (!snap) return send(res, { ok: false, error: 'No snapshot yet — startup refresh in progress' }, 404);
      return send(res, { ok: true, snap, analysis, news });
    }

    // ── OPPORTUNITIES — all scored instruments ───────────────
    if (pathname === '/api/opportunities') {
      const [analysis, instruments] = await Promise.all([
        fb.getLatestAIAnalysis(),
        fb.getAllInstruments(),
      ]);
      const scores   = analysis?.scores?.scores || {};
      const minScore = parseInt(query.min_score || '0');
      const country  = query.country || 'ALL';

      const opportunities = Object.entries(scores)
        .filter(([tk, s]) => {
          if (s.score < minScore) return false;
          if (country !== 'ALL') {
            const inst = instruments[tk];
            if (inst && inst.country !== country) return false;
          }
          return true;
        })
        .sort((a, b) => b[1].score - a[1].score)
        .map(([tk, s]) => {
          const inst = instruments[tk] || {};
          return {
            tk, ...s,
            name:      inst.name,
            sector:    inst.sector,
            country:   inst.country || 'IN',
            last_price:inst.last_price,
            valuation: inst.valuation,
            calibration: inst.calibration ? {
              base_returns: inst.calibration.base_returns,
              sigma:        inst.calibration.sigma,
              source:       inst.calibration.source,
            } : null,
            ai_context: inst.ai_context,
          };
        });

      return send(res, { ok: true, opportunities, count: opportunities.length, generated_at: analysis?.generated_at });
    }

    // ── PORTFOLIO P&L ────────────────────────────────────────
    if (pathname === '/api/portfolio') {
      const [prefs, snap] = await Promise.all([fb.getPreferences(), fb.getLatestSnapshot()]);
      const usdInr = snap?.usdInr || 92.35;
      const portfolio = Object.entries(prefs.portfolio || {}).map(([tk, pos]) => {
        const curr   = snap?.usPrices?.[tk] || pos.avg;
        const plPct  = ((curr - pos.avg) / pos.avg * 100);
        const plUSD  = (curr - pos.avg) * pos.qty;
        return {
          tk, ...pos,
          current: curr,
          pl_pct:  parseFloat(plPct.toFixed(2)),
          pl_usd:  parseFloat(plUSD.toFixed(2)),
          pl_inr:  Math.round(plUSD * usdInr),
        };
      });
      return send(res, { ok: true, portfolio, usdInr, snap_ts: snap?.ts });
    }

    // ── STATS ─────────────────────────────────────────────────
    if (pathname === '/api/stats') {
      const [snap, analysis, cal] = await Promise.all([
        fb.getLatestSnapshot(),
        fb.getLatestAIAnalysis(),
        fb.getLastCalibration(),
      ]);
      return send(res, {
        ok: true,
        regime:           snap?.regime,
        regime_score:     snap?.regime_score,
        fii_net:          snap?.fii?.fii_net,
        nifty:            snap?.indices?.['NIFTY 50']?.last,
        vix:              snap?.indices?.['INDIA VIX']?.last,
        usdInr:           snap?.usdInr,
        brent:            snap?.brent,
        top5:             analysis?.scores?.top5 || [],
        avoid:            analysis?.scores?.avoid || [],
        market_mood:      analysis?.market_mood,
        snapshot_ts:      snap?.ts,
        snapshot_age_min: snap?.ts ? Math.round((Date.now() - new Date(snap.ts).getTime()) / 60000) : null,
        price_count:      Object.keys(snap?.prices || {}).length,
        calibration: {
          last_run:       cal?.completed_at,
          instruments:    cal?.calibrated,
          valuations:     cal?.valuations,
        },
        errors:           snap?.errors || [],
        fetch_success:    snap?.success || [],
      });
    }

    // ── SEED MULTI-ASSET INSTRUMENTS ─────────────────────────
    if (pathname === '/api/seed-instruments') {
      const result = await fb.seedMultiAssetInstruments();
      return send(res, { ok: true, ...result });
    }

    // ── CALIBRATION STATUS ───────────────────────────────────
    if (pathname === '/api/calibration') {
      const cal   = await fb.getLastCalibration();
      const count = await fb.getAllInstruments().then(i => Object.keys(i).length).catch(() => 0);
      return send(res, {
        ok: true,
        last_run:          cal?.completed_at,
        calibrated:        cal?.calibrated,
        valuations:        cal?.valuations,
        total:             cal?.total,
        errors:            cal?.errors?.length,
        instrument_count:  count,
        next_run:          'Sunday 2:00 AM IST',
      });
    }

    // ── MANUAL REFRESH ───────────────────────────────────────
    if (pathname === '/api/refresh') {
      const type = query.type || 'morning';
      send(res, { ok: true, message: `${type} refresh started` });
      if (type === 'recalibrate') runWeeklyRecalibration().catch(console.error);
      else runMorningRefresh().catch(console.error);
      return;
    }

    // ── PREFERENCES ───────────────────────────────────────────
    if (pathname === '/api/preferences') {
      if (req.method === 'GET') {
        const prefs = await fb.getPreferences();
        return send(res, { ok: true, prefs });
      }
      if (req.method === 'POST') {
        const body = await parseBody(req);
        await fb.savePreferences(body);
        return send(res, { ok: true });
      }
    }



    // ── BACKTEST RESULTS ─────────────────────────────────────
    if (pathname === '/api/backtest') {
      const bt = await fb.getBacktest();
      return send(res, { ok: true, backtest: bt });
    }

    // ── ALERTS HISTORY ───────────────────────────────────────
    if (pathname === '/api/alerts') {
      const alerts = await fb.logAlert ? [] : [];
      return send(res, { ok: true, alerts });
    }

    // ── REGISTER DEVICE (Android app FCM token) ────────────
    if (pathname === '/api/register-device' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body.token) {
        await fcm.saveFCMToken(body.token, body.platform || 'android');
        return send(res, { ok: true, message: 'Device registered' });
      }
      return send(res, { ok: false, error: 'No token provided' }, 400);
    }

    // ── SEND TEST NOTIFICATION ───────────────────────────────
    if (pathname === '/api/test-notification') {
      const result = await fcm.sendNotification(
        '📊 Test Notification',
        'Investment Radar Pro is connected and working!',
        { type: 'TEST', screen: 'Dashboard' }
      );
      return send(res, { ok: result.ok, result });
    }

    // ── TEST AI (debug endpoint) ────────────────────────────
    if (pathname === '/api/test-ai') {
      try {
        const ai = require('./ai');
        const result = await ai.callHaiku('Return ONLY this JSON: {"test": "ok", "model": "haiku"}', 50);
        return send(res, { ok: true, result, key_prefix: process.env.ANTHROPIC_API_KEY?.slice(0,10) + '...' });
      } catch(e) {
        return send(res, { ok: false, error: e.message });
      }
    }

    // ── TELEGRAM WEBHOOK ────────────────────────────────────
    if (pathname === '/webhook/telegram' && req.method === 'POST') {
      const body = await parseBody(req);
      await tg.handleIncomingMessage(body).catch(console.error);
      res.writeHead(200); return res.end('ok');
    }

    // ── TELEGRAM SETUP GUIDE ─────────────────────────────────
    if (pathname === '/api/setup-telegram') {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!token || token === 'YOUR_BOT_TOKEN') {
        return send(res, {
          ok: false,
          step: 1,
          instructions: [
            'Open Telegram → search @BotFather',
            'Send: /newbot',
            'Choose a name: Investment Radar Pro',
            'Choose a username: investment_radar_yourname_bot',
            'Copy the token BotFather gives you',
            'Add to Render env vars: TELEGRAM_BOT_TOKEN = <token>',
            'Then open: https://t.me/your_bot_username',
            'Send any message to your bot',
            'Then visit: https://api.telegram.org/bot<TOKEN>/getUpdates',
            'Copy the chat id number',
            'Add to Render env vars: TELEGRAM_CHAT_ID = <chat_id>',
            'Redeploy Render → visit /api/test-telegram',
          ]
        });
      }
      if (!chatId || chatId === 'YOUR_CHAT_ID') {
        return send(res, {
          ok: false,
          step: 2,
          token_set: true,
          instructions: [
            `Open Telegram and message your bot`,
            `Then visit: https://api.telegram.org/bot${token}/getUpdates`,
            'Copy the "id" number from "chat" object',
            'Add to Render: TELEGRAM_CHAT_ID = <that number>',
          ]
        });
      }
      // Both set - send test
      const testResult = await tg.sendTestMessage();
      return send(res, { ok: testResult.ok, step: 3, message: 'Check your Telegram!', result: testResult });
    }

    // ── TEST TELEGRAM ────────────────────────────────────────
    if (pathname === '/api/test-telegram') {
      const result = await tg.sendTestMessage();
      return send(res, { ok: result.ok, result });
    }

    // ── NEWS LOOP STATUS ────────────────────────────────────
    if (pathname === '/api/news-status') {
      return send(res, { ok: true, ...getNewsLoopStatus() });
    }

    // ── STOCK NEWS ───────────────────────────────────────────
    if (pathname === '/api/news') {
      const symbol = query.symbol;
      if (symbol) {
        const { getStockNews } = require('./jobs/newsLoop');
        const news = await getStockNews(symbol);
        return send(res, { ok: true, symbol, news });
      }
      const { getMarketNews } = require('./jobs/newsLoop');
      const news = await getMarketNews();
      return send(res, { ok: true, news });
    }

    // ── AI ASK endpoint — proxies Anthropic for dashboard stock briefs ──
    if (pathname === '/api/ask' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { prompt, system, max_tokens = 1000 } = JSON.parse(body);
          const Anthropic = require('@anthropic-ai/sdk');
          const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
          const msg = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens,
            system: system || 'You are a helpful investment analyst.',
            messages: [{ role: 'user', content: prompt }],
          });
          send(res, { ok: true, text: msg.content?.[0]?.text || '' });
        } catch(e) {
          send(res, { ok: false, error: e.message }, 500);
        }
      });
      return;
    }

    send(res, { error: 'Not found', endpoints: ['/health','/api/snapshot','/api/opportunities','/api/portfolio','/api/stats','/api/calibration','/api/refresh','/api/preferences','/webhook/telegram'] }, 404);

  } catch (e) {
    console.error('Server error:', e);
    send(res, { error: 'Internal error', message: e.message }, 500);
  }
});

// ── START ─────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║   Investment Radar Pro — Phase 3 (Firebase + Nifty 500)      ║
╠══════════════════════════════════════════════════════════════╣
║   All Haiku ($2.81/month) | Firebase free tier               ║
║   6x daily refresh | Weekly recalibration Sunday 2AM         ║
║   Total cost: ~$15.46/month                                  ║
╚══════════════════════════════════════════════════════════════╝`);

  // Start continuous 24/7 news loop FIRST
  console.log('\nStarting 24/7 news loop...');
  startNewsLoop();

  // Startup: run morning refresh
  console.log('Startup refresh...');
  runMorningRefresh().catch(e => console.error('Startup error:', e.message));

  // Start scheduler
  scheduleNext();
});
