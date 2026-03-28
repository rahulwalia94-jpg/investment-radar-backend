// ═══════════════════════════════════════════════════════════════
// storage.js — Backblaze B2 Storage Manager
// Replaces Firebase completely. Fixed $6/month, 1TB.
// Handles both JSON data files and SQLite price_history.db
// ═══════════════════════════════════════════════════════════════

const https  = require('https');
const fs     = require('fs');
const crypto = require('crypto');
const zlib   = require('zlib');
const path   = require('path');

// ── CONFIG ────────────────────────────────────────────────────
const B2_KEY_ID    = () => process.env.B2_KEY_ID;
const B2_APP_KEY   = () => process.env.B2_APP_KEY;
const BUCKET_ID    = () => process.env.B2_BUCKET_ID;
const BUCKET_NAME  = () => process.env.B2_BUCKET_NAME || 'investment-radar-data';

// ── AUTH STATE ────────────────────────────────────────────────
let _auth = {
  token:       null,
  apiUrl:      null,
  downloadUrl: null,
  expiry:      0,
};

// ── AUTHORIZE (token valid 24h, refresh at 23h) ───────────────
async function authorize() {
  if (_auth.token && Date.now() < _auth.expiry) return;

  const creds = Buffer.from(`${B2_KEY_ID()}:${B2_APP_KEY()}`).toString('base64');
  const data  = await httpsGet('api.backblazeb2.com', '/b2api/v3/b2_authorize_account', {
    Authorization: `Basic ${creds}`,
  });

  _auth.token       = data.authorizationToken;
  _auth.apiUrl      = data.apiInfo.storageApi.apiUrl;
  _auth.downloadUrl = data.apiInfo.storageApi.downloadUrl;
  _auth.expiry      = Date.now() + 23 * 3600 * 1000;
  console.log('✅ B2 authorized');
}

// ── SAVE JSON DATA ────────────────────────────────────────────
async function save(key, data) {
  try {
    await authorize();
    const json    = JSON.stringify(data);
    const buf     = Buffer.from(json, 'utf8');
    const sha1    = crypto.createHash('sha1').update(buf).digest('hex');
    const urlData = await apiPost('/b2api/v3/b2_get_upload_url', { bucketId: BUCKET_ID() });
    await httpsUpload(urlData.uploadUrl, urlData.authorizationToken, key, buf, sha1, 'application/json');
    return true;
  } catch(e) {
    console.error(`B2 save(${key}) error:`, e.message);
    return false;
  }
}

// ── LOAD JSON DATA ────────────────────────────────────────────
async function load(key) {
  try {
    await authorize();
    const url  = new URL(`${_auth.downloadUrl}/file/${BUCKET_NAME()}/${key}`);
    const buf  = await httpsDownloadBuffer(url.hostname, url.pathname, _auth.token);
    return JSON.parse(buf.toString('utf8'));
  } catch(e) {
    if (e.message?.includes('404') || e.message?.includes('not found')) return null;
    console.error(`B2 load(${key}) error:`, e.message);
    return null;
  }
}

// ── UPLOAD BINARY FILE (price_history.db) ─────────────────────
async function uploadDB(localPath, remoteName = 'price_history.db') {
  try {
    await authorize();
    const buf     = fs.readFileSync(localPath);
    const sha1    = crypto.createHash('sha1').update(buf).digest('hex');
    const urlData = await apiPost('/b2api/v3/b2_get_upload_url', { bucketId: BUCKET_ID() });
    await httpsUpload(urlData.uploadUrl, urlData.authorizationToken, remoteName, buf, sha1, 'application/octet-stream');
    console.log(`✅ Uploaded ${remoteName} (${(buf.length/1024/1024).toFixed(1)}MB)`);
    return true;
  } catch(e) {
    console.error(`B2 uploadDB error:`, e.message);
    return false;
  }
}

// ── DOWNLOAD BINARY FILE ──────────────────────────────────────
async function downloadDB(remoteName = 'price_history.db', localPath = '/tmp/price_history.db') {
  try {
    await authorize();
    const url = new URL(`${_auth.downloadUrl}/file/${BUCKET_NAME()}/${remoteName}`);
    const buf = await httpsDownloadBuffer(url.hostname, url.pathname, _auth.token);
    fs.writeFileSync(localPath, buf);
    console.log(`✅ Downloaded ${remoteName} (${(buf.length/1024/1024).toFixed(1)}MB)`);
    return localPath;
  } catch(e) {
    console.error(`B2 downloadDB error:`, e.message);
    return null;
  }
}

// ── LOW-LEVEL HTTPS HELPERS ───────────────────────────────────
function httpsGet(hostname, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: pathname, method: 'GET', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString();
        try {
          const j = JSON.parse(txt);
          if (j.status >= 400 || j.code) reject(new Error(j.message || j.code || txt));
          else resolve(j);
        } catch(e) { reject(new Error(txt.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url     = new URL(_auth.apiUrl + path);
    const opts    = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers: {
        Authorization:    _auth.token,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString();
        try {
          const j = JSON.parse(txt);
          if (j.status >= 400) reject(new Error(j.message || 'B2 API error'));
          else resolve(j);
        } catch(e) { reject(new Error(txt.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpsUpload(uploadUrl, uploadAuth, fileName, buf, sha1, contentType) {
  return new Promise((resolve, reject) => {
    const url  = new URL(uploadUrl);
    const opts = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers: {
        Authorization:       uploadAuth,
        'X-Bz-File-Name':    encodeURIComponent(fileName),
        'Content-Type':      contentType,
        'Content-Length':    buf.length,
        'X-Bz-Content-Sha1': sha1,
      },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString();
        try {
          const j = JSON.parse(txt);
          if (j.fileId) resolve(j);
          else reject(new Error(j.message || 'Upload failed'));
        } catch(e) { reject(new Error(txt.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function httpsDownloadBuffer(hostname, pathname, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname,
      path:    pathname,
      method:  'GET',
      headers: { Authorization: token },
    };
    const req = https.request(opts, res => {
      if (res.statusCode === 404) { reject(new Error('404 not found')); return; }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { save, load, uploadDB, downloadDB, authorize };
