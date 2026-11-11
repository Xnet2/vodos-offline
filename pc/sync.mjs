// VODOS לנגן M36 — רץ ברקע במחשב:
//  • כל רבע שעה מוריד למחשב את הסרטונים החדשים מכל המקורות (מהטבלה של האתר), עד הנפח שנבחר בהגדרות האפליקציה
//  • כשמתחבר נגן (או טלפון) שמותקנת בו אפליקציית VODOS — קורא ממנו מה נצפה, מה סומן "אהבתי" ואת ההגדרות (state-*.json),
//    ומעתיק אליו את מה שחסר, יחד עם קובץ רשימה (index-*.json) לאפליקציה VODOS שבנגן
//  האפליקציה בנגן מוחקת בעצמה סרטונים שכבר לא ברשימה, כך שהנגן לא מתמלא: סרטונים שנצפו מתחלפים בחדשים,
//  ו"אהבתי" נשארים תמיד ולא נכללים במכסה.
// שימוש:  node sync.mjs          (ברקע, כמו בהפעלה האוטומטית)
//         node sync.mjs --once   (סנכרון אחד עכשיו, אם הנגן מחובר)
import { createHash } from 'node:crypto';
import http from 'node:http';
import { setDefaultResultOrder } from 'node:dns';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const GB = 1024 ** 3;
const KEEP_FREE = 500 * 1024 ** 2;   // להשאיר לפחות 500MB פנויים בנגן
const REFRESH_MS = 15 * 60 * 1000;   // כל כמה זמן לבדוק סרטונים חדשים
const POLL_MS = 3000;                // כל כמה זמן לבדוק אם הנגן חובר (בדיקה מהירה)
const SITE = 'https://xnet2.github.io/VOD/';

setDefaultResultOrder('ipv4first'); // דרך נטפרי חלק מהאתרים לא עונים ב-IPv6

const here = dirname(fileURLToPath(import.meta.url));
const HOME = join(process.env.LOCALAPPDATA || here, 'VODOS-M36');
const CACHE = join(HOME, 'videos');
mkdirSync(CACHE, { recursive: true });

// ---- מצב לחלון "VODOS — מצב" במחשב (http://127.0.0.1:47800) ----
const ui = {
  connected: false, device: '', storage: '', free: 0,
  busy: false, title: '', text: '', error: false, done: 0, total: 0,
  last: null, log: [],
};

function log(...a) {
  const line = new Date().toLocaleString('he-IL') + '  ' + a.join(' ');
  console.log(line);
  ui.log.push(line); if (ui.log.length > 80) ui.log.shift();
  // אם log.txt נעול או חסום לכתיבה — ממשיכים ביומן חלופי, העיקר לא לעצור
  for (const name of ['vodos-log.txt', 'vodos-log2.txt']) { try { appendFileSync(join(HOME, name), line + '\n'); return; } catch {} }
}

// מחיקה שלא עוצרת את הסנכרון אם קובץ אחד לא נמחק (למשל נעול)
const rmFailed = new Set(); // לרשום ביומן פעם אחת לכל קובץ, לא בכל רענון
function rm(p) {
  try { rmSync(p, { force: true }); }
  catch (e) { if (!rmFailed.has(p)) { rmFailed.add(p); log('לא הצלחתי למחוק', p.split(/[\\/]/).pop(), e.code || e.message); } }
}

// ---- מה שהגיע מהנגן בחיבור האחרון: הגדרות, אהבתי ומה נצפה (נשמר במחשב בין חיבורים) ----
function loadJSON(name, def) { try { return JSON.parse(readFileSync(join(HOME, name), 'utf8')); } catch { return def; } }
function saveJSON(name, v) {
  try { writeFileSync(join(HOME, name), JSON.stringify(v)); }
  catch { rm(join(HOME, name)); try { writeFileSync(join(HOME, name), JSON.stringify(v)); } catch (e) { log('לא הצלחתי לשמור', name, e.code || e.message); } }
}
let settings = { pcGB: 2, deviceGB: 2, ...loadJSON('settings.json', {}) };
let likes = loadJSON('likes.json', []);                  // [{f,s,t,ts}]
const watched = new Set(loadJSON('watched.json', []));   // שמות קבצים שכבר נצפו בנגן
const likedNames = () => new Set(likes.map(v => v.f));

// מעדכן מה-state של האפליקציה; מחזיר true אם הנפח במחשב השתנה (וצריך לרענן מחדש)
function applyState(text) {
  let st; try { st = JSON.parse(text); } catch { return false; }
  const before = settings.pcGB;
  const num = (x, d) => (x > 0 && x <= 1024 ? +x : d);
  if (st.settings) settings = { pcGB: num(st.settings.pcGB, settings.pcGB), deviceGB: num(st.settings.deviceGB, settings.deviceGB) };
  if (Array.isArray(st.likes)) likes = st.likes.filter(v => v && typeof v.f === 'string');
  for (const f of st.watched || []) watched.add(f);
  for (const f of watched) { if (watched.size <= 20000) break; watched.delete(f); }
  saveJSON('settings.json', settings); saveJSON('likes.json', likes); saveJSON('watched.json', [...watched]);
  log(`מהנגן: ${likes.length} אהבתי, ${(st.watched || []).length} נצפו, נפח ${settings.pcGB}GB במחשב / ${settings.deviceGB}GB לנגן`);
  return settings.pcGB !== before;
}

// מריץ את mtp.ps1; כל שורת JSON שהוא מדפיס מגיעה ל-onLine מיד (להתקדמות), וכולן חוזרות בסוף
// העתקה לאחסון שאסור לכתוב אליו (למשל הזיכרון הפנימי באנדרואיד 11+) יכולה להיתקע לתמיד — לכן לכל פעולה יש זמן מקסימלי
const TIMEOUT = { find: 60e3, put: 60e3, state: 120e3, pull: 60e3, push: 60 * 60e3 };
// האחסון בנגן שבו נמצאים הסרטונים (נשמר רק כשבאמת היה בו index — כדי לא "להינעל" על הזיכרון הפנימי)
let storagePref = loadJSON('storage2.json', {}).name || '';
let session = '';          // מזהה החיבור הנוכחי (נשלח בהודעות לנגן; העצירה מתייחסת אליו)
let stopRequested = false; // ביקשו בנגן לעצור את העדכון — מפסיקים להוריד ולהעתיק

// mtp.ps1 רץ כתהליך PowerShell אחד שנשאר פתוח (mtp.ps1 serve) — הפעלה של PowerShell לוקחת כמה שניות,
// ובלי זה כל בדיקה "האם הנגן חובר" עלתה בזה. הפקודות נשלחות אליו אחת אחרי השנייה; אם פקודה נתקעת — התהליך
// נסגר ונפתח חדש בפקודה הבאה.
let worker = null, seq = 0, queue = Promise.resolve();

function getWorker() {
  if (worker) return worker;
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'mtp.ps1'), 'serve'], { windowsHide: true });
  const w = { child, pending: null };
  createInterface({ input: child.stdout }).on('line', (l) => {
    let o; try { o = JSON.parse(l); } catch { return; }
    const p = w.pending; if (!p) return;
    if (o.end === p.id) p.finish();
    else { p.lines.push(o); if (p.onLine) p.onLine(o); }
  });
  child.on('error', () => {});
  child.on('close', () => { if (worker === w) worker = null; if (w.pending) w.pending.finish({ error: 'mtp.ps1 נסגר' }); });
  worker = w;
  return w;
}

// args: ['put', '-Local', dir, '-List', name] → כל שורות ה-JSON שהפקודה הדפיסה
function ps(args, onLine) {
  const run = () => new Promise((resolve) => {
    const w = getWorker(), id = ++seq, lines = [];
    const req = { id, action: args[0], storage: storagePref, session };
    for (let i = 1; i < args.length; i += 2) req[args[i].slice(1).toLowerCase()] = args[i + 1];
    const timer = setTimeout(() => {
      lines.push({ timeout: true });
      w.pending = null; if (worker === w) worker = null;
      try { w.child.kill(); } catch {}
      resolve(lines);
    }, TIMEOUT[args[0]] || 120e3);
    w.pending = { id, lines, onLine, finish: (extra) => { clearTimeout(timer); w.pending = null; if (extra) lines.push(extra); resolve(lines); } };
    w.child.stdin.write(JSON.stringify(req) + '\n');
  });
  const p = queue.then(run);
  queue = p.catch(() => {});
  return p;
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
    if (video) { try { faststart(path + '.part'); } catch (e) { log('faststart:', e.message); } }
    renameSync(path + '.part', path);
  } finally { clearTimeout(timer); rmSync(path + '.part', { force: true }); }
}

// בחלק מהסרטונים "תוכן העניינים" (moov) נמצא בסוף הקובץ, והנגן צריך לקרוא עד הסוף לפני שהוא מתחיל לנגן.
// מעבירים אותו להתחלה (כמו qt-faststart) — ומעדכנים את המיקומים שבו, שזזים בגודל שלו
function faststart(path) {
  const buf = readFileSync(path);
  const boxes = [];
  for (let pos = 0; pos + 8 <= buf.length;) {
    let size = buf.readUInt32BE(pos), head = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(pos + 8)); head = 16; }
    else if (size === 0) size = buf.length - pos;
    if (size < head || pos + size > buf.length) return false; // קובץ לא תקין — לא נוגעים
    boxes.push({ type: buf.toString('latin1', pos + 4, pos + 8), pos, size });
    pos += size;
  }
  const moov = boxes.find(b => b.type === 'moov'), mdat = boxes.find(b => b.type === 'mdat');
  if (!moov || !mdat || moov.pos < mdat.pos || boxes.some(b => b.type === 'moof')) return false;
  const m = Buffer.from(buf.subarray(moov.pos, moov.pos + moov.size));
  const shift = (o) => (o >= mdat.pos && o < moov.pos ? o + moov.size : o);
  (function walk(start, end) {
    for (let p = start; p + 8 <= end;) {
      const size = m.readUInt32BE(p), type = m.toString('latin1', p + 4, p + 8);
      if (size < 8 || p + size > end) throw new Error('bad box ' + type);
      if (type === 'cmov') throw new Error('compressed moov');
      if (['trak', 'mdia', 'minf', 'stbl'].includes(type)) walk(p + 8, p + size);
      else if (type === 'stco') {
        for (let i = 0, n = m.readUInt32BE(p + 12); i < n; i++) {
          const o = shift(m.readUInt32BE(p + 16 + i * 4));
          if (o > 0xffffffff) throw new Error('stco overflow');
          m.writeUInt32BE(o, p + 16 + i * 4);
        }
      } else if (type === 'co64') {
        for (let i = 0, n = m.readUInt32BE(p + 12); i < n; i++) m.writeBigUInt64BE(BigInt(shift(Number(m.readBigUInt64BE(p + 16 + i * 8)))), p + 16 + i * 8);
      }
      p += size;
    }
  })(8, m.length);
  const parts = [];
  for (const b of boxes) {
    if (b === moov) continue;
    if (b === mdat) parts.push(m);
    parts.push(buf.subarray(b.pos, b.pos + b.size));
  }
  writeFileSync(path, Buffer.concat(parts));
  return true;
}

let refreshing = null, refreshError = null;
let selection = null; // { videos, sources }
let onDownload = null; // בזמן חיבור: מדווח לנגן על כל סרטון שהורד

function refresh() {
  if (!refreshing) {
    refreshError = null;
    refreshing = doRefresh().catch(e => { refreshError = e; log('שגיאה ברענון:', e.message); }).finally(() => { refreshing = null; });
  }
  return refreshing;
}

// ---- הודעות מצב לנגן: status-<זמן>.json, שהאפליקציה מציגה כהתראה ובפס שבפיד ----
// {title, text, done?, error?} — נשלחות אחת-אחת; אם בינתיים הגיעה חדשה יותר, הביניים מדולגות
const STATUS_DIR = join(HOME, 'status');
let statusBusy = null, statusNext = null;
function status(title, text, extra = {}) {
  Object.assign(ui, { title, text, error: !!extra.error, done: 0, total: 0 }); // אותה הודעה גם בחלון במחשב
  statusNext = { title, text, session, ...extra };
  if (!statusBusy) statusBusy = (async () => {
    while (statusNext) {
      const s = statusNext; statusNext = null;
      try {
        mkdirSync(STATUS_DIR, { recursive: true });
        for (const f of readdirSync(STATUS_DIR)) rm(join(STATUS_DIR, f));
        const name = 'status-' + Date.now() + '.json';
        writeFileSync(join(STATUS_DIR, name), JSON.stringify(s));
        const out = await ps(['put', '-Local', STATUS_DIR, '-List', name]);
        if (!out.some(o => o.ok)) log('הודעת מצב לא הגיעה לנגן' + (out.some(o => o.timeout) ? ' (נתקע)' : ''));
      } catch (e) { log('הודעת מצב לא נשלחה:', e.message); }
    }
    statusBusy = null;
  })();
}
async function statusFlush() { while (statusBusy) await statusBusy; }

async function doRefresh() {
  const cfg = await loadConfig();
  const MAX_BYTES = settings.pcGB * GB;
  const liked = likedNames();
  // מה שכבר נצפה לא מורידים שוב; "אהבתי" כבר שמורים בצד ולא נספרים בנפח
  const all = (await loadVideos(cfg)).filter(v => !watched.has(nameOf(v)) && !liked.has(nameOf(v)));
  const picked = [], sources = {};
  let bytes = 0, fresh = 0;
  const queue = all[Symbol.iterator]();
  // הורדה בשלושה ערוצים במקביל, מהחדש לישן, עד שמגיעים לנפח
  async function worker() {
    for (const v of queue) {
      if (bytes >= MAX_BYTES || stopRequested) return;
      const name = nameOf(v), path = join(CACHE, name);
      if (!existsSync(path)) {
        if ((failed.get(v.videoUrl) || 0) > Date.now()) continue;
        try { await download(v.videoUrl, path); fresh++; if (onDownload) onDownload(fresh); }
        catch (e) { failed.set(v.videoUrl, Date.now() + 6 * 3600 * 1000); continue; }
      }
      bytes += statSync(path).size;
      picked.push({ ...v, f: name });
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  // נעצר באמצע — הרשימה חלקית, אז לא מחליפים את הבחירה הקודמת ולא מוחקים כלום מהמחשב
  if (stopRequested) { log(`ההורדה הופסקה (${fresh} חדשים הורדו)`); return; }
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

  const keep = new Set(picked.map(v => v.f).concat([...liked], Object.values(sources).map(s => s.avatar).filter(a => a && !a.startsWith('data:'))));
  for (const f of readdirSync(CACHE)) if (!keep.has(f) && !f.startsWith('index-')) rm(join(CACHE, f));
  selection = { videos: picked, sources };
  log(`רענון: ${picked.length} סרטונים (${(bytes / GB).toFixed(2)}GB מתוך ${settings.pcGB}GB), ${fresh} חדשים הורדו`);
}

// ---- העתקה לנגן ----
// have — הקבצים שכבר בנגן (הם לא תופסים מקום נוסף)
// fresh — עדכון יומי: כל הסרטונים בנגן נמחקים (חוץ מ"אהבתי"), והנגן מתמלא מחדש בחדשים ביותר
async function push(free, have, fresh) {
  if (!selection) await refresh();
  if (!selection) return;
  const liked = likedNames(), onDevice = new Set(have);
  const size = (f) => { try { return statSync(join(CACHE, f)).size; } catch { return -1; } };
  // "אהבתי" — תמיד, אם הם בנגן או במחשב; לא נספרים בנפח
  const keepLiked = likes.filter(v => onDevice.has(v.f) || size(v.f) >= 0);
  // השאר: מה שלא נצפה, מהחדש לישן, עד הנפח שנבחר לנגן — ובלי למלא את המקום הפנוי בנגן
  let room = free - KEEP_FREE - keepLiked.reduce((a, v) => a + (onDevice.has(v.f) ? 0 : size(v.f)), 0), used = 0;
  // ביומי: המקום של כל הסרטונים שבנגן (חוץ מ"אהבתי") מתפנה — וכל סרטון שנבחר נספר, גם אם הוא כבר שם
  if (fresh) room += have.filter(f => /\.(mp4|mov|m4v|webm)$/.test(f) && !liked.has(f)).reduce((a, f) => a + Math.max(0, size(f)), 0);
  const videos = selection.videos.filter(v => {
    if (watched.has(v.f) || liked.has(v.f)) return false;
    const s = size(v.f); if (s < 0) return false;
    if (used + s > settings.deviceGB * GB) return false;
    if (fresh || !onDevice.has(v.f)) { if (s > room) return false; room -= s; }
    used += s; return true;
  });
  const sources = { ...selection.sources };
  for (const v of keepLiked) if (!sources[v.s]) sources[v.s] = { name: v.s };

  for (const f of readdirSync(CACHE)) if (f.startsWith('index-')) rm(join(CACHE, f));
  const index = 'index-' + Date.now() + '.json';
  writeFileSync(join(CACHE, index), JSON.stringify({
    created: new Date().toISOString(), sources,
    videos: keepLiked.map(v => ({ f: v.f, s: v.s, t: v.t, ts: v.ts }))
      .concat(videos.map(v => ({ f: v.f, s: v.source, t: v.text, ts: v.timestamp }))),
  }));
  const names = keepLiked.map(v => v.f).concat(videos.map(v => v.f), Object.values(sources).map(s => s.avatar).filter(a => a && !a.startsWith('data:')), [index]);
  for (const f of readdirSync(HOME)) if (/^push-.*\.txt$/.test(f)) rm(join(HOME, f));
  const list = join(HOME, 'push-' + Date.now() + '.txt'); // שם חדש בכל פעם — לא נתקעים על קובץ ישן
  writeFileSync(list, names.join('\n'), 'utf8');

  // ההתקדמות מוצגת בנגן עצמו: mtp.ps1 שולח קודם רשימה (sync-*.json), והאפליקציה סופרת מה כבר הגיע
  log((fresh ? 'עדכון יומי: ' : '') + `מעתיק לנגן (${videos.length} סרטונים ברשימה, ${(used / GB).toFixed(2)}GB, ועוד ${keepLiked.length} אהבתי)…`);
  const out = await ps(['push', '-Local', CACHE, '-List', list].concat(fresh ? ['-Clean', '1'] : []), (o) => {
    // ההתקדמות גם בחלון במחשב
    if (o.todo != null) Object.assign(ui, { title: 'מעתיק סרטונים לנגן', text: o.todo ? `0 מתוך ${o.todo}` : 'אין קבצים חדשים להעתיק', done: 0, total: o.todo });
    if (o.file) Object.assign(ui, { done: o.done, text: `${o.done} מתוך ${ui.total}` });
  });
  const err = out.find(o => o.error);
  if (err) throw new Error(err.error);
  if (out.some(o => o.timeout)) throw new Error('ההעתקה נתקעה');
  const stopped = out.find(o => o.stopped);
  if (stopped) { stopRequested = true; log(`ההעתקה הופסקה (${stopped.copied} קבצים הועתקו)`); return; }
  const copied = out.filter(o => o.file && o.ok && /\.(mp4|mov|m4v|webm)$/.test(o.file)).length;
  const bad = out.filter(o => o.file && !o.ok).length;
  log(`הועתקו ${copied} סרטונים חדשים` + (bad ? `, ${bad} נכשלו` : ''));
  ui.last = { at: new Date().toISOString(), copied, videos: videos.length + keepLiked.length };
  saveJSON('last.json', ui.last);
  Object.assign(ui, { title: 'הנגן מעודכן ✓', text: copied ? `נוספו ${copied} סרטונים חדשים` : 'אין סרטונים חדשים', error: false, done: 0, total: 0 });
}

async function syncDevice(dev, fresh) {
  const KEEP = ' · אל תנתקו את הנגן';
  stopRequested = false;
  session = Date.now().toString(36); // מזהה החיבור — נשלח בכל הודעה; עצירה בנגן נכתבת כ-stop-<מזהה>.txt
  ui.busy = true;
  status(fresh ? 'עדכון יומי' : 'הנגן מחובר למחשב', (fresh ? 'הנגן יתמלא מחדש בסרטונים הכי חדשים…' : 'בודק אם יש סרטונים חדשים…') + KEEP);
  let last = 0, stopTimer = null, checking = null;
  // בדיקה אחת אם ביקשו בנגן לעצור (בדיקות לא חופפות: אם יש אחת באוויר — מחכים לה)
  const checkStop = () => {
    if (stopRequested) return Promise.resolve(true);
    if (!checking) checking = ps(['stopcheck']).then(([r]) => {
      checking = null;
      if (r && r.stop && !stopRequested) { stopRequested = true; log('ביקשו בנגן לעצור'); status('עוצר את העדכון…', 'עוד רגע'); }
      return stopRequested;
    });
    return checking;
  };
  onDownload = (n) => {
    if (Date.now() - last < 8000) return; // לא להציף את הנגן בהודעות
    last = Date.now();
    status('המחשב מוריד סרטונים חדשים', `הורדו ${n} עד עכשיו` + KEEP);
  };
  const stoppedMsg = () => status('העדכון הופסק', 'הסרטונים שכבר הגיעו לנגן נשארים. חברו שוב כדי להמשיך', { error: true });
  try {
    const tmp = join(HOME, 'from-device');
    mkdirSync(tmp, { recursive: true });
    await statusFlush();
    const [st] = await ps(['state', '-Local', tmp]);
    if (st && st.error) throw new Error(st.error);
    if (st && st.timeout) throw new Error('קריאה מהנגן נתקעה');
    Object.assign(ui, { storage: st.storage || '', free: st.free || 0 });
    if (st.hasIndex && st.storage !== storagePref) { storagePref = st.storage; saveJSON('storage2.json', { name: storagePref }); log('אחסון בנגן:', storagePref); }
    const changed = st && st.state ? applyState(st.state) : false;
    // עצירה נבדקת: עכשיו, כל 5 שניות בזמן ההורדה, לפני ההעתקה, ולפני כל קובץ בהעתקה (ב-mtp.ps1)
    if (await checkStop()) { stoppedMsg(); return; }
    stopTimer = setInterval(checkStop, 5000);
    if (refreshing) status('המחשב מוריד סרטונים חדשים', 'מחכה שההורדה תסתיים…' + KEEP);
    await refresh();
    if ((changed || !selection) && !stopRequested) await refresh(); // הנפח במחשב השתנה — לבחור מחדש
    clearInterval(stopTimer);
    onDownload = null;
    if (await checkStop()) { stoppedMsg(); return; }
    if (!selection) {
      status('לא הצלחתי להוריד סרטונים', 'בדקו שיש אינטרנט במחשב, ונסו לחבר שוב', { error: true });
      return;
    }
    status('מכין את ההעתקה לנגן…', (refreshError ? 'אין אינטרנט במחשב — מעתיק את מה שכבר הורד' : 'עוד רגע מתחילים') + KEEP);
    await statusFlush();
    if (await checkStop()) { stoppedMsg(); return; }
    log(`אחסון: ${st.storage}, פנוי ${((st.free || 0) / GB).toFixed(1)}GB`);
    await push(st.free || 0, st.have || [], fresh); // מכאן ההתקדמות מוצגת בנגן לפי קובץ ה-sync
    if (stopRequested) stoppedMsg();
  } catch (e) {
    log('שגיאה בהעתקה:', e.message);
    status('ההעתקה נכשלה', 'נתקו וחברו שוב את הנגן', { error: true });
  } finally {
    clearInterval(stopTimer);
    if (checking) await checking;
    onDownload = null;
    await statusFlush();
    stopRequested = false;
    ui.busy = false;
    rm(stopFlag());
  }
}

// ---- חלון המצב במחשב: http://127.0.0.1:47800 (קיצור "VODOS" על שולחן העבודה) ----
// עצירה מהחלון: קובץ stop-<מזהה החיבור>.flag במחשב — mtp.ps1 בודק גם אותו, כמו את בקשת העצירה מהנגן
function stopFlag() { return join(HOME, `stop-${session}.flag`); }
function startServer() {
  const page = join(here, 'status.html');
  http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/stop') {
      if (ui.busy && !stopRequested) {
        try { writeFileSync(stopFlag(), ''); } catch {}
        stopRequested = true; log('עצירה מהחלון במחשב'); status('עוצר את העדכון…', 'עוד רגע');
      }
      res.writeHead(204); return res.end();
    }
    // "התחל עדכון" בחלון — רק אז ניגשים לנגן (עד אז לא נכתב אליו כלום)
    if (req.method === 'POST' && (req.url === '/start' || req.url === '/start?fresh=1')) {
      const fresh = req.url.endsWith('fresh=1');
      if (ui.connected && !ui.busy) { startNow = fresh ? 'fresh' : 'normal'; log(fresh ? 'עדכון יומי מהחלון במחשב' : 'התחלת עדכון מהחלון במחשב'); wake(); }
      res.writeHead(204); return res.end();
    }
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        ...ui, stopping: stopRequested, settings, likes: likes.length, watched: watched.size,
        cache: selection ? { videos: selection.videos.length, bytes: selection.videos.reduce((a, v) => { try { return a + statSync(join(CACHE, v.f)).size; } catch { return a; } }, 0) } : null,
        downloading: !!refreshing,
      }));
    }
    if (req.url === '/' || req.url.startsWith('/?')) {
      try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(readFileSync(page)); }
      catch { res.writeHead(500); return res.end('status.html missing'); }
    }
    res.writeHead(404); res.end();
  }).on('error', (e) => log('חלון המצב לא עלה:', e.code || e.message)).listen(47800, '127.0.0.1');
}
let startNow = false, wake = () => {};
// בכל חיבור של הנגן — פותחים את חלון המצב בדפדפן (לשונית ישנה של החלון נסגרת לבד, ראו status.html)
function openWindow() {
  try { spawn('cmd.exe', ['/c', 'start', '""', 'http://127.0.0.1:47800/'], { windowsHide: true, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref(); }
  catch (e) { log('לא הצלחתי לפתוח את חלון המצב:', e.message); }
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
  ui.last = loadJSON('last.json', null);
  startServer();
  refresh();
  setInterval(refresh, REFRESH_MS);
  let wasConnected = false;
  for (;;) {
    const dev = await findDevice();
    ui.connected = !!dev; ui.device = dev ? dev.device : '';
    if (!dev && wasConnected) Object.assign(ui, { title: '', text: '', error: false, done: 0, total: 0 }); // נותק
    // חיבור: רק פותחים את חלון המצב ושואלים. העדכון (וכל הודעה בנגן) מתחיל רק בלחיצה על "התחל עדכון"
    if (dev && !wasConnected) {
      log('מכשיר חובר: ' + dev.device);
      startNow = false;
      openWindow();
    }
    wasConnected = !!dev;
    if (dev && startNow) { const fresh = startNow === 'fresh'; startNow = false; await syncDevice(dev, fresh); continue; }
    if (!dev) startNow = false;
    await new Promise(r => { wake = r; setTimeout(r, POLL_MS); });
  }
}

// תקלה לא צפויה לא מפילה את התוכנה — רק נרשמת ביומן
process.on('uncaughtException', (e) => log('תקלה:', e.stack || e.message));
process.on('unhandledRejection', (e) => log('תקלה:', (e && e.stack) || e));
main().catch(e => { log('שגיאה:', e.stack || e.message); process.exit(1); });
