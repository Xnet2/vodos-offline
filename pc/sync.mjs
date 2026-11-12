// VODOS לנגן M36 — רץ ברקע במחשב:
//  • כשמתחבר נגן (או טלפון) שמותקנת בו אפליקציית VODOS — פותח את חלון המצב בדפדפן, ומחכה ללחיצה על "התחל עדכון"
//  • בעדכון: קורא מהנגן מה נצפה, מה סומן "אהבתי" ואת ההגדרות (state-*.json), מוריד את הסרטונים הכי חדשים
//    ומעתיק כל אחד לנגן מיד, עם קובץ רשימה (index-*.json) לאפליקציה. המחשב לא שומר סרטונים.
//  האפליקציה בנגן מוחקת סרטונים שכבר לא ברשימה, כך שהנגן תמיד על הכי חדשים; "אהבתי" נשארים תמיד ולא נכללים במכסה.
// שימוש:  node sync.mjs          (ברקע, כמו בהפעלה האוטומטית)
//         node sync.mjs --once   (סנכרון אחד עכשיו, אם הנגן מחובר)
import { createHash } from 'node:crypto';
import http from 'node:http';
import { setDefaultResultOrder } from 'node:dns';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createWriteStream, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const GB = 1024 ** 3;
const KEEP_FREE = 500 * 1024 ** 2;   // להשאיר לפחות 500MB פנויים בנגן
const POLL_MS = 3000;                // כל כמה זמן לבדוק אם הנגן חובר (בדיקה מהירה)
const SITE = 'https://xnet2.github.io/VOD/';

setDefaultResultOrder('ipv4first'); // דרך נטפרי חלק מהאתרים לא עונים ב-IPv6

const here = dirname(fileURLToPath(import.meta.url));
const HOME = join(process.env.LOCALAPPDATA || here, 'VODOS-M36');
const CACHE = join(HOME, 'videos'); // תיקייה זמנית: סרטון יושב בה רק עד שהוא מועתק לנגן
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

// מעדכן מה-state של האפליקציה
function applyState(text) {
  let st; try { st = JSON.parse(text); } catch { return; }
  const num = (x, d) => (x > 0 && x <= 1024 ? +x : d);
  if (st.settings) settings = { pcGB: num(st.settings.pcGB, settings.pcGB), deviceGB: num(st.settings.deviceGB, settings.deviceGB) };
  if (Array.isArray(st.likes)) likes = st.likes.filter(v => v && typeof v.f === 'string');
  for (const f of st.watched || []) watched.add(f);
  for (const f of watched) { if (watched.size <= 20000) break; watched.delete(f); }
  saveJSON('settings.json', settings); saveJSON('likes.json', likes); saveJSON('watched.json', [...watched]);
  log(`מהנגן: ${likes.length} אהבתי, ${(st.watched || []).length} נצפו, נפח ${settings.deviceGB}GB לנגן`);
}

// מריץ את mtp.ps1; כל שורת JSON שהוא מדפיס מגיעה ל-onLine מיד (להתקדמות), וכולן חוזרות בסוף
// העתקה לאחסון שאסור לכתוב אליו (למשל הזיכרון הפנימי באנדרואיד 11+) יכולה להיתקע לתמיד — לכן לכל פעולה יש זמן מקסימלי
const TIMEOUT = { find: 60e3, put: 60e3, state: 120e3, pull: 60e3, push: 4 * 3600e3 }; // push — כולל ההורדות
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

// ---- הורדה (לתיקייה הזמנית, בזמן עדכון) ----
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

// ---- עדכון: הכל קורה רק כשלוחצים "התחל עדכון" — המחשב לא שומר סרטונים ----
// 1. בוחרים מהטבלה את הסרטונים הכי חדשים שלא נצפו, עד הנפח שנבחר לנגן. מה שכבר בנגן נספר לפי הגודל שלו שם;
//    לחדשים בודקים את הגודל בשרת לפני ההורדה
// 2. האפליקציה בנגן מוחקת כל סרטון שלא ברשימה (חוץ מ"אהבתי") — כך יש מקום, והנגן תמיד על הכי חדשים
// 3. מורידים לתיקייה זמנית, שלושה במקביל, ו-mtp.ps1 מעתיק כל סרטון לנגן ברגע שהוא מוכן ומוחק אותו מהמחשב
// 4. בסוף נכתבת הרשימה (index-*.json) — רק עם מה שבאמת הגיע
const EST = 12 * 1024 ** 2; // שרת שלא אומר מה הגודל — מניחים גודל ממוצע של סרטון
function clearTmp() { try { for (const f of readdirSync(CACHE)) rm(join(CACHE, f)); } catch {} }
function touch(p) { try { writeFileSync(p, ''); } catch {} }

// הגודל של סרטון בשרת, בלי להוריד אותו (בקשה לבייט הראשון בלבד); -1 — לא זמין (או דף "נשלח לבדיקה" של נטפרי)
async function remoteSize(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 VODOS-M36', Range: 'bytes=0-0' } });
    ctrl.abort(); // את התוכן עצמו לא צריך
    if (!res.ok || !/video|octet-stream/i.test(res.headers.get('content-type') || '')) return -1;
    const m = (res.headers.get('content-range') || '').match(/\/(\d+)$/);
    if (m) return +m[1];
    const len = +res.headers.get('content-length');
    return res.status === 200 && len > 1 ? len : EST;
  } catch { return -1; } finally { clearTimeout(timer); }
}

// st — מה שנקרא מהנגן: have (כל הקבצים), sizes (הסרטונים והגודל שלהם), free
async function update(st, KEEP) {
  clearTmp();
  status('בודק מה חדש…', 'קורא את רשימת הסרטונים' + KEEP);
  const cfg = await loadConfig();
  const liked = likedNames(), sizes = st.sizes || {}, onDevice = new Set(st.have || []);
  const all = (await loadVideos(cfg)).filter(v => !watched.has(nameOf(v)) && !liked.has(nameOf(v)) && (failed.get(v.videoUrl) || 0) <= Date.now());
  // "אהבתי" שבנגן נשארים תמיד, ולא נספרים בנפח
  const keepLiked = likes.filter(v => onDevice.has(v.f));
  // המקום של כל הסרטונים שבנגן (חוץ מ"אהבתי") מתפנה — וכל סרטון שנבחר נספר, גם אם הוא כבר שם
  let room = (st.free || 0) - KEEP_FREE, used = 0;
  for (const f in sizes) if (!liked.has(f)) room += sizes[f];
  const budget = settings.deviceGB * GB, picked = [];
  // מהחדש לישן, עד הנפח — ונעצרים בראשון שלא נכנס, כדי שבנגן יהיו בדיוק הכי חדשים
  scan: for (let i = 0; i < all.length; i += 8) {
    if (stopRequested) return;
    const batch = all.slice(i, i + 8).map(v => ({ ...v, f: nameOf(v) }));
    const got = await Promise.all(batch.map(v => (sizes[v.f] != null ? sizes[v.f] : remoteSize(v.videoUrl))));
    for (let j = 0; j < batch.length; j++) {
      const v = batch[j], s = got[j];
      if (s < 0) { failed.set(v.videoUrl, Date.now() + 6 * 3600e3); continue; }
      if (used + s > budget || s > room) break scan;
      room -= s; used += s;
      picked.push({ ...v, have: sizes[v.f] != null });
    }
  }
  if (stopRequested) return;
  const toGet = picked.filter(v => !v.have);
  log(`עדכון: ${picked.length} סרטונים (${(used / GB).toFixed(2)}GB מתוך ${settings.deviceGB}GB), ${toGet.length} חדשים להוריד, ועוד ${keepLiked.length} אהבתי`);

  // תמונה לכל מקור (קטנות — מורידים לפני ההעתקה)
  const sources = {};
  for (const v of picked) {
    if (sources[v.source]) continue;
    const src = { name: v.sourceName || v.source };
    const av = (cfg.SOURCE_AVATARS || {})[v.source] || v.avatar || '';
    if (av.startsWith('data:')) src.avatar = av;
    else if (av) {
      const url = new URL(av, SITE).href;
      const file = 'avatar-' + v.source.replace(/[^a-z0-9]/gi, '') + '.' + ((url.match(/\.(png|jpe?g|webp|gif)(\?|$)/i) || [, 'png'])[1].toLowerCase());
      if (onDevice.has(file)) src.avatar = file;
      else { try { await download(url, join(CACHE, file), { video: false }); src.avatar = file; } catch {} }
    }
    sources[v.source] = src;
  }
  for (const v of keepLiked) if (!sources[v.s]) sources[v.s] = { name: v.s };

  const index = 'index-' + Date.now() + '.json';
  const names = keepLiked.map(v => v.f).concat(picked.map(v => v.f), Object.values(sources).map(s => s.avatar).filter(a => a && !a.startsWith('data:')), [index]);
  for (const f of readdirSync(HOME)) if (/^push-.*\.txt$/.test(f)) rm(join(HOME, f));
  const list = join(HOME, 'push-' + Date.now() + '.txt');
  writeFileSync(list, names.join('\n'), 'utf8');

  // ההורדות רצות ברקע בזמן ש-mtp.ps1 מעתיק; סרטון שנכשל מסומן <שם>.skip, ו-mtp.ps1 ממשיך לבא
  let stopDl = false, got = 0;
  const arrived = new Set(), queue = toGet[Symbol.iterator]();
  async function dl() {
    for (const v of queue) {
      const p = join(CACHE, v.f);
      if (stopDl || stopRequested) { touch(p + '.skip'); continue; }
      try { await download(v.videoUrl, p); arrived.add(v.f); got++; }
      catch (e) { failed.set(v.videoUrl, Date.now() + 6 * 3600e3); log('הורדה נכשלה:', v.f, e.message); touch(p + '.skip'); }
    }
  }
  const downloads = Promise.all([dl(), dl(), dl()]).then(() => {
    // הרשימה לאפליקציה — רק מה שכבר בנגן או שירד (נכתבת בשם זמני ואז מקבלת את השם, כדי ש-mtp.ps1 לא יעתיק חצי קובץ)
    const ok = picked.filter(v => v.have || arrived.has(v.f));
    writeFileSync(join(CACHE, index + '.tmp'), JSON.stringify({
      created: new Date().toISOString(), sources,
      videos: keepLiked.map(v => ({ f: v.f, s: v.s, t: v.t, ts: v.ts }))
        .concat(ok.map(v => ({ f: v.f, s: v.source, t: v.text, ts: v.timestamp }))),
    }));
    renameSync(join(CACHE, index + '.tmp'), join(CACHE, index));
  }).catch((e) => { log('הרשימה לנגן לא נכתבה:', e.message); touch(join(CACHE, index + '.skip')); }); // שלא יחכה לה לנצח

  status('מעדכן את הנגן', `מוריד ומעתיק ${toGet.length} סרטונים חדשים` + KEEP);
  await statusFlush();
  let done = 0, total = 0;
  const out = await ps(['push', '-Local', CACHE, '-List', list, '-Clean', '1', '-Wait', '1'], (o) => {
    // ההתקדמות גם בחלון במחשב (בנגן — לפי קובץ ה-sync)
    if (o.todo != null) { total = o.todo; Object.assign(ui, { title: 'מוריד ומעתיק לנגן', text: total ? `0 מתוך ${total}` : 'אין סרטונים חדשים', done: 0, total }); }
    if (o.file) { done = o.done; Object.assign(ui, { done, text: `${done} מתוך ${total}` + (got < toGet.length ? ` · הורדו ${got}` : '') }); }
  });
  stopDl = true;
  downloads.finally(clearTmp); // הורדה שעוד באמצע — נמחקת כשהיא מסתיימת
  const err = out.find(o => o.error);
  if (err) throw new Error(err.error);
  if (out.some(o => o.timeout)) throw new Error('ההעתקה נתקעה');
  const stopped = out.find(o => o.stopped);
  if (stopped) { stopRequested = true; log(`העדכון הופסק (${stopped.copied} קבצים הועתקו)`); return; }
  const copied = out.filter(o => o.file && o.ok && /\.(mp4|mov|m4v|webm)$/.test(o.file)).length;
  const bad = toGet.length - copied;
  log(`הועתקו ${copied} סרטונים חדשים` + (bad > 0 ? `, ${bad} לא הצליחו` : ''));
  ui.last = { at: new Date().toISOString(), copied, videos: picked.length + keepLiked.length };
  saveJSON('last.json', ui.last);
  Object.assign(ui, { title: 'הנגן מעודכן ✓', text: (copied ? `נוספו ${copied} סרטונים חדשים` : 'אין סרטונים חדשים') + ` · ${picked.length + keepLiked.length} בנגן`, error: false, done: 0, total: 0 });
}


async function syncDevice(dev) {
  const KEEP = ' · אל תנתקו את הנגן';
  stopRequested = false;
  session = Date.now().toString(36); // מזהה החיבור — נשלח בכל הודעה; עצירה בנגן נכתבת כ-stop-<מזהה>.txt
  ui.busy = true;
  status('מתחיל עדכון', 'קורא מהנגן מה כבר נצפה…' + KEEP);
  let stopTimer = null, checking = null;
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
    if (st && st.state) applyState(st.state);
    log(`אחסון: ${st.storage}, פנוי ${((st.free || 0) / GB).toFixed(1)}GB`);
    // עצירה נבדקת: עכשיו, כל 5 שניות בזמן הבחירה, ולפני כל קובץ בהעתקה (ב-mtp.ps1)
    if (await checkStop()) { stoppedMsg(); return; }
    stopTimer = setInterval(checkStop, 5000);
    await update(st, KEEP);
    if (stopRequested) stoppedMsg();
  } catch (e) {
    log('שגיאה בעדכון:', e.message);
    // בלי אינטרנט אי אפשר לעדכן (המחשב לא שומר סרטונים מראש)
    const net = /fetch failed|HTTP \d|ENOTFOUND|ECONN|ETIMEDOUT|github|google/i.test(e.message);
    status(net ? 'אין חיבור לאינטרנט' : 'העדכון נכשל', net ? 'בדקו שיש אינטרנט במחשב ולחצו שוב "התחל עדכון"' : 'נתקו וחברו שוב את הנגן', { error: true });
  } finally {
    clearInterval(stopTimer);
    if (checking) await checking;
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
    if (req.method === 'POST' && req.url.startsWith('/start')) {
      if (ui.connected && !ui.busy) { startNow = true; log('התחלת עדכון מהחלון במחשב'); wake(); }
      res.writeHead(204); return res.end();
    }
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        ...ui, stopping: stopRequested, settings, likes: likes.length, watched: watched.size,
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
  clearTmp(); // סרטונים שנשארו מגרסה קודמת (שהורידה מראש למחשב) או מעדכון שנקטע
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
    if (dev && startNow) { startNow = false; await syncDevice(dev); continue; }
    if (!dev) startNow = false;
    await new Promise(r => { wake = r; setTimeout(r, POLL_MS); });
  }
}

// תקלה לא צפויה לא מפילה את התוכנה — רק נרשמת ביומן
process.on('uncaughtException', (e) => log('תקלה:', e.stack || e.message));
process.on('unhandledRejection', (e) => log('תקלה:', (e && e.stack) || e));
main().catch(e => { log('שגיאה:', e.stack || e.message); process.exit(1); });
