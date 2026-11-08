// VODOS לנגן M36 — רץ ברקע במחשב:
//  • כל רבע שעה מוריד למחשב את הסרטונים החדשים מכל המקורות (מהטבלה של האתר), עד MAX_BYTES
//  • כשמתחבר נגן (או טלפון) שמותקנת בו אפליקציית VODOS — מעתיק אליו את מה שחסר, יחד עם קובץ רשימה (index-*.json) לאפליקציה VODOS שבנגן
//  האפליקציה בנגן מוחקת בעצמה סרטונים שכבר לא ברשימה, כך שהנגן לא מתמלא.
// שימוש:  node sync.mjs          (ברקע, כמו בהפעלה האוטומטית)
//         node sync.mjs --once   (סנכרון אחד עכשיו, אם הנגן מחובר)
import { createHash } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_BYTES = 2 * 1024 ** 3;     // כמה סרטונים לשמור בנגן (2GB ≈ 400 סרטונים)
const KEEP_FREE = 500 * 1024 ** 2;   // להשאיר לפחות 500MB פנויים בנגן
const REFRESH_MS = 15 * 60 * 1000;   // כל כמה זמן לבדוק סרטונים חדשים
const POLL_MS = 8000;                // כל כמה זמן לבדוק אם הנגן חובר
const SITE = 'https://xnet2.github.io/VOD/';

setDefaultResultOrder('ipv4first'); // דרך נטפרי חלק מהאתרים לא עונים ב-IPv6

const here = dirname(fileURLToPath(import.meta.url));
const HOME = join(process.env.LOCALAPPDATA || here, 'VODOS-M36');
const CACHE = join(HOME, 'videos');
mkdirSync(CACHE, { recursive: true });

function log(...a) {
  const line = new Date().toLocaleString('he-IL') + '  ' + a.join(' ');
  console.log(line);
  try { appendFileSync(join(HOME, 'log.txt'), line + '\n'); } catch {}
}

// מריץ את mtp.ps1; כל שורת JSON שהוא מדפיס מגיעה ל-onLine מיד (להתקדמות), וכולן חוזרות בסוף
function ps(args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'mtp.ps1'), ...args], { windowsHide: true });
    const lines = [];
    createInterface({ input: child.stdout }).on('line', (l) => {
      let o; try { o = JSON.parse(l); } catch { return; }
      lines.push(o); if (onLine) onLine(o);
    });
    child.on('error', reject);
    child.on('close', (code) => { if (code && !lines.length) reject(new Error('mtp.ps1 exit ' + code)); else resolve(lines); });
  });
}

// ---- ההגדרות והטבלה — כמו באתר ----
// עד 3 ניסיונות — דרך נטפרי חיבור נכשל לפעמים לרגע
async function getText(url) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      if (i === 3) throw new Error(new URL(url).hostname + ': ' + e.message);
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
}

async function loadConfig() {
  const code = await getText(SITE + 'config.js');
  const window = {};
  new Function('window', code)(window);
  return window.VOD_CONFIG || {};
}

function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const plain = (t) => String(t || '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
function fileKey(url) { try { const u = new URL(url); return u.host + u.pathname; } catch { return url; } }
function isMarketing(text, source, exempt) {
  const t = (text || '').trim(); if (!t) return false;
  if (!exempt.has(source) && ((t.match(/\p{Extended_Pictographic}/gu)) || []).length > 2) return true;
  const lines = t.split(/\n+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length >= 5);
  const seenLines = new Set();
  for (const l of lines) { if (seenLines.has(l)) return true; seenLines.add(l); }
  const wc = {};
  for (const w of t.split(/\s+/)) { if (w.length >= 4) { wc[w] = (wc[w] || 0) + 1; if (wc[w] >= 3) return true; } }
  return false;
}

async function loadVideos(cfg) {
  const rows = parseCSV(await getText(cfg.SHEET_CSV));
  const head = rows.shift();
  const col = (n) => head.indexOf(n);
  const exempt = new Set(cfg.EMOJI_RULE_EXEMPT || []);
  const list = rows.filter(r => r.length > 1).map(r => ({
    videoUrl: r[col('videoUrl')] || '', source: r[col('source')] || '', sourceName: r[col('sourceName')] || '',
    avatar: r[col('avatar')] || '', text: r[col('text')] || '', timestamp: r[col('timestamp')] || '',
  })).filter(v => /^https:/.test(v.videoUrl) && !isMarketing(v.text, v.source, exempt));
  list.sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
  const files = new Set(), texts = new Set();
  return list.filter(v => {
    const f = fileKey(v.videoUrl), t = plain(v.text);
    if (files.has(f) || (t.length >= 15 && texts.has(t))) return false;
    files.add(f); if (t.length >= 15) texts.add(t);
    return true;
  });
}

// ---- הורדה למחשב ----
const failed = new Map(); // כתובת → מתי לנסות שוב (למשל קובץ שנטפרי עוד לא אישר)
const nameOf = (v) => {
  const ext = (fileKey(v.videoUrl).match(/\.(mp4|mov|m4v|webm)$/i) || [, 'mp4'])[1].toLowerCase();
  return v.source.replace(/[^a-z0-9]/gi, '') + '-' + createHash('sha1').update(fileKey(v.videoUrl)).digest('hex').slice(0, 12) + '.' + ext;
};

async function download(url, path, { video = true } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 VODOS-M36' } });
    const type = res.headers.get('content-type') || '';
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (video && !/video|octet-stream/i.test(type)) throw new Error('not a video (' + type + ')'); // למשל דף "נשלח לבדיקה" של נטפרי
    if (!video && !/image/i.test(type)) throw new Error('not an image (' + type + ')');
    await pipeline(Readable.fromWeb(res.body), createWriteStream(path + '.part'));
    renameSync(path + '.part', path);
  } finally { clearTimeout(timer); rmSync(path + '.part', { force: true }); }
}

let refreshing = null;
let selection = null; // { videos, sources }

function refresh() {
  if (!refreshing) refreshing = doRefresh().catch(e => log('שגיאה ברענון:', e.message)).finally(() => { refreshing = null; });
  return refreshing;
}

async function doRefresh() {
  const cfg = await loadConfig();
  const all = await loadVideos(cfg);
  const picked = [], sources = {};
  let bytes = 0, fresh = 0;
  const queue = all[Symbol.iterator]();
  // הורדה בשלושה ערוצים במקביל, מהחדש לישן, עד שמגיעים לנפח
  async function worker() {
    for (const v of queue) {
      if (bytes >= MAX_BYTES) return;
      const name = nameOf(v), path = join(CACHE, name);
      if (!existsSync(path)) {
        if ((failed.get(v.videoUrl) || 0) > Date.now()) continue;
        try { await download(v.videoUrl, path); fresh++; }
        catch (e) { failed.set(v.videoUrl, Date.now() + 6 * 3600 * 1000); continue; }
      }
      bytes += statSync(path).size;
      picked.push({ ...v, f: name });
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  picked.sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
  // שלושת הערוצים יכולים לעבור קצת את הנפח — חותכים לפי הסדר מהחדש לישן
  bytes = 0;
  for (let i = 0; i < picked.length; i++) {
    bytes += statSync(join(CACHE, picked[i].f)).size;
    if (bytes > MAX_BYTES) { bytes -= statSync(join(CACHE, picked[i].f)).size; picked.length = i; break; }
  }

  // תמונה לכל מקור
  for (const v of picked) {
    if (sources[v.source]) continue;
    const src = { name: v.sourceName || v.source };
    let av = (cfg.SOURCE_AVATARS || {})[v.source] || v.avatar || '';
    if (av.startsWith('data:')) src.avatar = av;
    else if (av) {
      const url = new URL(av, SITE).href;
      const file = 'avatar-' + v.source.replace(/[^a-z0-9]/gi, '') + '.' + ((url.match(/\.(png|jpe?g|webp|gif)(\?|$)/i) || [, 'png'])[1].toLowerCase());
      if (!existsSync(join(CACHE, file))) { try { await download(url, join(CACHE, file), { video: false }); } catch {} }
      if (existsSync(join(CACHE, file))) src.avatar = file;
    }
    sources[v.source] = src;
  }

  const keep = new Set(picked.map(v => v.f).concat(Object.values(sources).map(s => s.avatar).filter(a => a && !a.startsWith('data:'))));
  for (const f of readdirSync(CACHE)) if (!keep.has(f) && !f.startsWith('index-')) rmSync(join(CACHE, f), { force: true });
  selection = { videos: picked, sources };
  log(`רענון: ${picked.length} סרטונים (${(bytes / 1024 ** 3).toFixed(2)}GB), ${fresh} חדשים הורדו`);
}

// ---- העתקה לנגן ----
async function push(free) {
  if (!selection) await refresh();
  if (!selection) return;
  let { videos, sources } = selection;
  // אם אין מספיק מקום בנגן — שולחים פחות (הכי חדשים קודם)
  let room = free - KEEP_FREE, used = 0;
  videos = videos.filter(v => { const s = statSync(join(CACHE, v.f)).size; if (used + s > room) return false; used += s; return true; });

  for (const f of readdirSync(CACHE)) if (f.startsWith('index-')) rmSync(join(CACHE, f), { force: true });
  const index = 'index-' + Date.now() + '.json';
  writeFileSync(join(CACHE, index), JSON.stringify({
    created: new Date().toISOString(), sources,
    videos: videos.map(v => ({ f: v.f, s: v.source, t: v.text, ts: v.timestamp })),
  }));
  const names = videos.map(v => v.f).concat(Object.values(sources).map(s => s.avatar).filter(a => a && !a.startsWith('data:')), [index]);
  const list = join(HOME, 'push-list.txt');
  writeFileSync(list, names.join('\n'), 'utf8');

  // ההתקדמות מוצגת בנגן עצמו: mtp.ps1 שולח קודם רשימה (sync-*.json), והאפליקציה סופרת מה כבר הגיע
  log(`מעתיק לנגן (${videos.length} סרטונים ברשימה)…`);
  const out = await ps(['push', '-Local', CACHE, '-List', list]);
  const err = out.find(o => o.error);
  if (err) throw new Error(err.error);
  const copied = out.filter(o => o.file && o.ok && /\.(mp4|mov|m4v|webm)$/.test(o.file)).length;
  const bad = out.filter(o => o.file && !o.ok).length;
  log(`הועתקו ${copied} סרטונים חדשים` + (bad ? `, ${bad} נכשלו` : ''));
}

async function syncDevice(dev) {
  try { await refresh(); await push(dev.free); }
  catch (e) { log('שגיאה בהעתקה:', e.message); }
}

// ---- לולאה ראשית ----
async function findDevice() {
  try { const [r] = await ps(['find']); return r && r.connected ? r : null; }
  catch { return null; }
}

async function main() {
  const once = process.argv.includes('--once');
  log('VODOS לנגן התחיל' + (once ? ' (סנכרון אחד)' : ''));
  if (once) {
    const dev = await findDevice();
    if (!dev) { log('הנגן לא מחובר'); return; }
    await syncDevice(dev);
    return;
  }
  refresh();
  setInterval(refresh, REFRESH_MS);
  let wasConnected = false;
  for (;;) {
    const dev = await findDevice();
    if (dev && !wasConnected) {
      log('הנגן חובר (' + dev.storage + ', פנוי ' + (dev.free / 1024 ** 3).toFixed(1) + 'GB)');
      await syncDevice(dev);
    }
    wasConnected = !!dev;
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main().catch(e => { log('שגיאה:', e.stack || e.message); process.exit(1); });
