// ═══════════════════════════════════════════════════════════════
// telegram.js — Free Telegram Bot Notifications
// Setup: 5 minutes. No approval needed.
//
// SETUP STEPS:
// 1. Open Telegram → search @BotFather
// 2. Send /newbot → follow steps → copy the token
// 3. Start a chat with your new bot
// 4. Visit: https://api.telegram.org/bot{TOKEN}/getUpdates
// 5. Copy your chat_id from the response
// 6. Add to Render env vars:
//    TELEGRAM_BOT_TOKEN = 7xxxxx:ABCxxx...
//    TELEGRAM_CHAT_ID   = 123456789
// ═══════════════════════════════════════════════════════════════

const https = require('https');

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID   || '';

// ── SEND MESSAGE ─────────────────────────────────────────────
function sendMessage(text, parseMode = 'Markdown') {
  return new Promise(resolve => {
    if (!TOKEN || !CHAT_ID) {
      console.log('Telegram not configured — skipping notification');
      return resolve({ ok: false, error: 'not_configured' });
    }

    const body = JSON.stringify({
      chat_id:    CHAT_ID,
      text:       text.slice(0, 4096), // Telegram limit
      parse_mode: parseMode,
      disable_web_page_preview: true,
    });

    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${TOKEN}/sendMessage`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, res => {
      let data = '';
      res.on('data', c => data += c.toString());
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.ok) {
            console.log('Telegram sent ✅');
            resolve({ ok: true, message_id: json.result?.message_id });
          } else {
            console.log('Telegram error:', json.description);
            resolve({ ok: false, error: json.description });
          }
        } catch(e) {
          resolve({ ok: false, error: e.message });
        }
      });
    });

    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
    req.write(body);
    req.end();
  });
}

// ── MORNING BRIEF ─────────────────────────────────────────────
async function sendMorningBrief(snap, scores, portfolio) {
  const fii    = snap.fii?.fii_net || 0;
  const nifty  = snap.indices?.['NIFTY 50'];
  const vix    = snap.indices?.['INDIA VIX'];
  const top3   = (scores?.top5 || []).slice(0, 3).join(', ') || '--';
  const usdInr = snap.usdInr || 86;
  const brent  = snap.brent  || 90;
  const regime = snap.regime || 'SIDEWAYS';

  // Portfolio P&L
  const portLines = Object.entries(portfolio || {}).map(([tk, pos]) => {
    const curr  = snap.usPrices?.[tk] || pos.avg;
    const plPct = ((curr - pos.avg) / pos.avg * 100).toFixed(1);
    const emoji = parseFloat(plPct) > 2 ? '🟢' : parseFloat(plPct) < -2 ? '🔴' : '🟡';
    return `${emoji} *${tk}* $${curr.toFixed(2)} (${plPct >= 0 ? '+' : ''}${plPct}%)`;
  }).join('\n');

  const REGIME_EMOJI = { BULL:'🚀', SOFT_BULL:'📈', SIDEWAYS:'➡️', SOFT_BEAR:'📉', BEAR:'🐻' };

  const text = [
    `${REGIME_EMOJI[regime] || '📊'} *Morning Brief — ${regime.replace('_',' ')}*`,
    ``,
    `📈 Nifty: *${nifty?.last?.toLocaleString('en-IN') || '--'}* (${(nifty?.pChange || 0) >= 0 ? '+' : ''}${(nifty?.pChange || 0).toFixed(1)}%)`,
    `😰 VIX: *${vix?.last?.toFixed(1) || '--'}* | FII: *${fii >= 0 ? '+' : ''}${Math.round(fii)} Cr*`,
    `🛢️ Brent: *$${brent?.toFixed(0)}* | USD/INR: *${usdInr?.toFixed(2)}*`,
    ``,
    `💼 *Portfolio*`,
    portLines || '—',
    ``,
    `🎯 *Top Picks Today*: ${top3}`,
    ``,
    `[→ Open Dashboard](${process.env.DASHBOARD_URL || 'https://rahulwalia94-jpg.github.io/investment-radar-dashboard/'})`,
  ].join('\n');

  return sendMessage(text);
}

// ── EVENING SUMMARY ───────────────────────────────────────────
async function sendEveningSummary(snap, scores, portfolio) {
  const nifty  = snap.indices?.['NIFTY 50'];
  const fii    = snap.fii?.fii_net || 0;
  const top3   = (scores?.top5 || []).slice(0, 3).join(', ') || '--';
  const usdInr = snap.usdInr || 86;

  const portLines = Object.entries(portfolio || {}).map(([tk, pos]) => {
    const curr  = snap.usPrices?.[tk] || pos.avg;
    const plPct = ((curr - pos.avg) / pos.avg * 100).toFixed(1);
    const plINR = ((curr - pos.avg) * pos.qty * usdInr).toFixed(0);
    const emoji = parseFloat(plPct) > 0 ? '🟢' : '🔴';
    return `${emoji} *${tk}* ${plPct >= 0 ? '+' : ''}${plPct}% | ₹${parseInt(plINR) >= 0 ? '+' : ''}${plINR}`;
  }).join('\n');

  const text = [
    `📈 *Evening Summary*`,
    ``,
    `Nifty closed *${nifty?.last?.toLocaleString('en-IN') || '--'}* (${(nifty?.pChange || 0) >= 0 ? '+' : ''}${(nifty?.pChange || 0).toFixed(1)}%)`,
    `FII: *${fii >= 0 ? '+' : ''}${Math.round(fii)} Cr* ${Math.abs(fii) > 5000 ? '⚡ SIGNIFICANT' : ''}`,
    ``,
    `💼 *P&L Today*`,
    portLines || '—',
    ``,
    `🎯 Watch tomorrow: *${top3}*`,
    ``,
    `[→ Full Analysis](${process.env.DASHBOARD_URL || ''})`,
  ].join('\n');

  return sendMessage(text);
}

// ── PRICE ALERT ───────────────────────────────────────────────
async function sendPriceAlert(stock, movePct, current, avg, qty) {
  const plPct = ((current - avg) / avg * 100).toFixed(1);
  const isUp  = parseFloat(movePct) > 0;

  const text = [
    `${isUp ? '🚀' : '⚠️'} *${stock} Alert*`,
    ``,
    `Moved *${movePct >= 0 ? '+' : ''}${movePct}%* today`,
    `Current: *$${current.toFixed(2)}* | Avg: $${avg}`,
    `Overall P&L: *${plPct >= 0 ? '+' : ''}${plPct}%*`,
    ``,
    `[→ View Portfolio](${process.env.DASHBOARD_URL || ''})`,
  ].join('\n');

  return sendMessage(text);
}

// ── FII ALERT ─────────────────────────────────────────────────
async function sendFIIAlert(fiiNet) {
  const isPos = fiiNet > 0;
  const text  = [
    `${isPos ? '📈' : '📉'} *FII ${isPos ? 'Buying' : 'Selling'} Surge*`,
    ``,
    `FII ${isPos ? 'bought' : 'sold'} *₹${Math.abs(Math.round(fiiNet)).toLocaleString('en-IN')} Cr* today`,
    `Signal: *${Math.abs(fiiNet) > 8000 ? 'VERY SIGNIFICANT' : 'Significant'}*`,
    ``,
    `[→ Dashboard](${process.env.DASHBOARD_URL || ''})`,
  ].join('\n');

  return sendMessage(text);
}

// ── REGIME CHANGE ALERT ───────────────────────────────────────
async function sendRegimeChangeAlert(oldRegime, newRegime, reason) {
  const EMOJI = { BULL:'🚀', SOFT_BULL:'📈', SIDEWAYS:'➡️', SOFT_BEAR:'📉', BEAR:'🐻' };
  const text  = [
    `🔄 *Regime Change*`,
    ``,
    `${EMOJI[oldRegime] || '📊'} ${oldRegime} → ${EMOJI[newRegime] || '📊'} *${newRegime}*`,
    ``,
    reason || 'Market conditions have shifted.',
    ``,
    `[→ Open Dashboard](${process.env.DASHBOARD_URL || ''})`,
  ].join('\n');

  return sendMessage(text);
}

// ── WEBHOOK HANDLER (incoming messages from user) ─────────────
async function handleIncomingMessage(update) {
  const msg  = update?.message;
  if (!msg) return;

  const text = (msg.text || '').trim().toUpperCase();
  const chatId = msg.chat?.id?.toString();

  // Auto-register chat ID if it matches
  if (chatId && chatId === CHAT_ID) {
    let reply = '';

    if (text === '/START' || text === 'START') {
      reply = `👋 *Investment Radar Pro*\n\nBot connected! You'll receive:\n• 📊 Morning brief at 9 AM IST\n• 📈 Evening summary at 10 PM IST\n• ⚡ Real-time price alerts\n• 🔄 Regime change alerts\n\n[→ Dashboard](${process.env.DASHBOARD_URL || ''})`;
    } else if (text === '/STATUS' || text === 'STATUS') {
      reply = `📡 *System Status*\n\nBackend: Live ✅\nNews loop: Running 24/7 ✅\nNext refresh: Auto-scheduled ✅\n\n[→ Dashboard](${process.env.DASHBOARD_URL || ''})`;
    } else if (text === '/HELP' || text === 'HELP') {
      reply = `*Commands:*\n/status — system status\n/start — welcome message\n\n[→ Dashboard](${process.env.DASHBOARD_URL || ''})`;
    }

    if (reply) await sendMessage(reply);
  }
}

// ── TEST ──────────────────────────────────────────────────────
async function sendTestMessage() {
  return sendMessage(
    `🔧 *Investment Radar Pro — Test*\n\nBot is connected and working!\nNotifications will arrive at:\n• 9:05 AM IST — Morning brief\n• 10:05 PM IST — Evening summary\n• Real-time — Price alerts\n\n[→ Dashboard](${process.env.DASHBOARD_URL || ''})`
  );
}

module.exports = {
  sendMessage,
  sendMorningBrief,
  sendEveningSummary,
  sendPriceAlert,
  sendFIIAlert,
  sendRegimeChangeAlert,
  handleIncomingMessage,
  sendTestMessage,
};
