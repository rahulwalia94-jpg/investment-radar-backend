// ═══════════════════════════════════════════════════════════════
// FCM Notification Service
// Uses Firebase Cloud Messaging HTTP v1 API directly
// No firebase-admin SDK needed — pure HTTPS calls
// Token stored in Backblaze B2 via db.js
// ═══════════════════════════════════════════════════════════════

const https = require('https');
const db    = require('./db');

// ── STORE/GET FCM TOKEN via B2 ────────────────────────────────
async function saveFCMToken(token, deviceInfo) {
  await db.savePreferences({ 
    ...(await db.getPreferences()),
    fcm_token: token, 
    fcm_device: deviceInfo || 'Android',
    fcm_registered_at: new Date().toISOString(),
  });
  console.log('FCM token saved:', token.slice(0, 20) + '...');
}

async function getFCMToken() {
  const prefs = await db.getPreferences();
  return prefs?.fcm_token || null;
}

// ── SEND NOTIFICATION via FCM HTTP v1 ─────────────────────────
// Uses server key (legacy) since we don't have OAuth2
// Falls back gracefully if no token configured
async function sendNotification(title, body, data = {}) {
  try {
    const token = await getFCMToken();
    if (!token) {
      console.log('No FCM token — Android app not registered yet');
      return { ok: false, error: 'no_token' };
    }

    const serverKey = process.env.FCM_SERVER_KEY;
    if (!serverKey) {
      console.log('FCM_SERVER_KEY not set — skipping push notification');
      return { ok: false, error: 'no_server_key' };
    }

    const payload = JSON.stringify({
      to: token,
      priority: 'high',
      notification: { title, body, sound: 'default', color: '#00d4aa' },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
    });

    return new Promise((resolve) => {
      const opts = {
        hostname: 'fcm.googleapis.com',
        path:     '/fcm/send',
        method:   'POST',
        headers: {
          Authorization:  `key=${serverKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };
      const req = https.request(opts, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.success === 1) {
              console.log('FCM sent:', title);
              resolve({ ok: true, messageId: j.results?.[0]?.message_id });
            } else {
              console.log('FCM failed:', j.results?.[0]?.error);
              resolve({ ok: false, error: j.results?.[0]?.error });
            }
          } catch(e) { resolve({ ok: false, error: d }); }
        });
      });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.write(payload);
      req.end();
    });
  } catch(e) {
    console.error('FCM error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── MORNING BRIEF ─────────────────────────────────────────────
async function sendMorningBrief(snap, scores, portfolio) {
  const fii   = snap?.fii?.fii_net || 0;
  const nifty = snap?.indices?.['NIFTY 50'];
  const top1  = scores?.top5?.[0] || '--';

  const portLines = Object.entries(portfolio || {}).map(([tk, pos]) => {
    const curr  = snap?.usPrices?.[tk] || pos.avg;
    const plPct = ((curr - pos.avg) / pos.avg * 100).toFixed(1);
    return `${parseFloat(plPct) >= 0 ? '🟢' : '🔴'} ${tk} ${plPct >= 0 ? '+' : ''}${plPct}%`;
  }).join('  ');

  return sendNotification(
    `📊 Morning Brief — ${snap?.regime || 'SIDEWAYS'}`,
    [
      `Nifty ${nifty?.last?.toLocaleString('en-IN') || '--'} (${nifty?.pChange >= 0 ? '+' : ''}${nifty?.pChange?.toFixed(1) || '0'}%)`,
      `FII ${fii >= 0 ? '+' : ''}${Math.round(fii)} Cr`,
      portLines,
      `Top pick: ${top1}`,
    ].filter(Boolean).join('\n'),
    { type: 'MORNING_BRIEF', regime: snap?.regime || 'SIDEWAYS',
      top_pick: top1, screen: 'Dashboard' }
  );
}

// ── EVENING SUMMARY ───────────────────────────────────────────
async function sendEveningSummary(snap, scores) {
  const nifty = snap?.indices?.['NIFTY 50'];
  const fii   = snap?.fii?.fii_net || 0;
  const top3  = (scores?.top5 || []).slice(0, 3).join(', ');
  return sendNotification(
    '📈 Evening Summary',
    `Nifty ${nifty?.last?.toLocaleString('en-IN') || '--'} (${nifty?.pChange >= 0 ? '+' : ''}${nifty?.pChange?.toFixed(1) || '0'}%)\nFII ${fii >= 0 ? '+' : ''}${Math.round(fii)} Cr\nTop picks: ${top3}`,
    { type: 'EVENING_SUMMARY', screen: 'Dashboard' }
  );
}

module.exports = {
  saveFCMToken, getFCMToken,
  sendNotification, sendMorningBrief, sendEveningSummary,
};
