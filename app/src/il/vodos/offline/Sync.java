package il.vodos.offline;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;

// מצב ההעתקה מהמחשב. התוכנה במחשב שולחת קודם sync-<זמן>.json עם רשימת הקבצים שבדרך (האחרון ברשימה הוא ה-index).
// ההתקדמות = כמה מהקבצים כבר הגיעו. אם כבר שתי דקות לא הגיע כלום והרשימה לא הושלמה — ההעתקה נקטעה (stalled).
final class Sync {
  static final class Status {
    boolean active, finished, stalled;
    int done, total, videos;
    long id; // הזמן של קובץ ה-sync (או של הודעת המצב) — מזהה את ההעתקה
    // הודעת מצב מהמחשב לפני ההעתקה (status-*.json): "הנגן מחובר", "המחשב מוריד…", או שגיאה
    boolean msg, error, stopping;
    String title = "", text = "";

    String json() {
      return "{\"active\":" + active + ",\"finished\":" + finished + ",\"done\":" + done + ",\"total\":" + total
          + ",\"videos\":" + videos + ",\"id\":" + id + ",\"msg\":" + msg + ",\"error\":" + error + ",\"stopping\":" + stopping
          + ",\"title\":" + JSONObject.quote(title) + ",\"text\":" + JSONObject.quote(text) + "}";
    }
  }

  static Status read(Context ctx) {
    Status s = readFiles(ctx);
    // ביקשו לעצור בשלוש הדקות האחרונות, והמחשב עוד לא אישר — "עוצר…"
    long stopAt = ctx.getSharedPreferences("sync", Context.MODE_PRIVATE).getLong("stopAt", 0);
    s.stopping = s.active && System.currentTimeMillis() - stopAt < 180000;
    return s;
  }

  // בקשה מהמחשב להפסיק: קובץ stop-<זמן>.txt בתיקייה של האפליקציה. המחשב בודק אם הופיע קובץ כזה
  // תוך כדי ההורדה וההעתקה, ועוצר (הסרטונים שכבר הגיעו נשארים)
  static void requestStop(final Context ctx) {
    ctx.getSharedPreferences("sync", Context.MODE_PRIVATE).edit().putLong("stopAt", System.currentTimeMillis()).apply();
    new Thread(() -> {
      for (File dir : ctx.getExternalFilesDirs(null)) {
        if (dir == null) continue;
        File f = new File(dir, "stop-" + System.currentTimeMillis() + ".txt");
        try { new java.io.FileOutputStream(f).close(); } catch (Exception e) { continue; }
        android.media.MediaScannerConnection.scanFile(ctx, new String[] { f.getPath() }, null, null);
      }
      log(ctx, "stop requested");
    }).start();
  }

  private static Status readFiles(Context ctx) {
    Status s = new Status();
    File sync = newest(ctx, "sync"), st = newest(ctx, "status");
    // הודעת מצב חדשה יותר מההעתקה האחרונה — המחשב עוד בשלב ההכנה (שני הזמנים לפי השעון של המחשב)
    if (st != null && (sync == null || stamp(st) > stamp(sync))) {
      try {
        JSONObject o = new JSONObject(read(st));
        s.msg = true;
        s.id = stamp(st);
        s.title = o.optString("title");
        s.text = o.optString("text");
        s.error = o.optBoolean("error") && System.currentTimeMillis() - st.lastModified() < 600000; // שגיאה ישנה כבר לא מעניינת
        // אם כבר 3 דקות אין הודעה חדשה — התוכנה במחשב נעצרה או שהנגן נותק
        s.active = !s.error && System.currentTimeMillis() - st.lastModified() < 180000;
        return s;
      } catch (Exception e) {
        return new Status(); // הקובץ עוד נכתב
      }
    }
    if (sync == null) return s;
    s.id = stamp(sync);
    long newest = sync.lastModified();
    try {
      JSONArray files = new JSONObject(read(sync)).getJSONArray("files");
      s.total = files.length();
      for (int i = 0; i < files.length(); i++) {
        String n = files.getString(i);
        if (n.matches(".+\\.(mp4|mov|m4v|webm)")) s.videos++;
        File f = new File(sync.getParentFile(), n);
        if (f.length() > 0) { s.done++; newest = Math.max(newest, f.lastModified()); }
      }
    } catch (Exception e) {
      return new Status(); // הקובץ עוד נכתב — ננסה שוב בבדיקה הבאה
    }
    s.finished = s.done >= s.total;
    s.active = !s.finished && System.currentTimeMillis() - newest < 120000;
    s.stalled = !s.finished && !s.active;
    return s;
  }

  static File newestSync(Context ctx) { return newest(ctx, "sync"); }

  static File newest(Context ctx, String prefix) {
    File best = null;
    for (File dir : ctx.getExternalFilesDirs(null)) {
      if (dir == null) continue;
      File[] list = dir.listFiles();
      if (list == null) continue;
      for (File f : list) if (f.getName().matches(prefix + "-\\d+\\.json") && (best == null || stamp(f) > stamp(best))) best = f;
    }
    return best;
  }

  // יומן קצר בנגן (applog.txt בתיקייה של האפליקציה) — כדי לראות מהמחשב מה קרה כשחיברו את הכבל
  static synchronized void log(Context ctx, String msg) {
    try {
      File dir = null;
      for (File d : ctx.getExternalFilesDirs(null)) if (d != null) dir = d; // הכרטיס, אם יש
      if (dir == null) return;
      File f = new File(dir, "applog.txt");
      if (f.length() > 64 * 1024) f.delete();
      String line = new java.text.SimpleDateFormat("dd/MM HH:mm:ss", java.util.Locale.US).format(new java.util.Date()) + "  " + msg + "\n";
      try (java.io.FileOutputStream o = new java.io.FileOutputStream(f, true)) { o.write(line.getBytes("UTF-8")); }
      android.media.MediaScannerConnection.scanFile(ctx, new String[] { f.getPath() }, null, null);
    } catch (Exception e) {}
  }

  static boolean charging(Context ctx) {
    Intent b = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
    return b != null && b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0;
  }

  // ---- התראות ----
  private static final String CHANNEL = "sync";
  private static final int ID = 1;

  private static Notification.Builder builder(Context ctx, NotificationManager nm) {
    Notification.Builder b;
    if (Build.VERSION.SDK_INT >= 26) {
      nm.createNotificationChannel(new NotificationChannel(CHANNEL, "העתקה מהמחשב", NotificationManager.IMPORTANCE_HIGH));
      b = new Notification.Builder(ctx, CHANNEL);
    } else {
      b = new Notification.Builder(ctx).setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_SOUND);
    }
    PendingIntent open = PendingIntent.getActivity(ctx, 0,
        new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_UPDATE_CURRENT);
    return b.setContentIntent(open).setOnlyAlertOnce(true);
  }

  // כפתור "עצור" בהתראה — או "עוצר…" אם כבר ביקשו
  @SuppressWarnings("deprecation")
  private static void stopAction(Context ctx, Notification.Builder b, Status s) {
    if (s.stopping) { b.setSubText("עוצר את העדכון…"); return; }
    PendingIntent stop = PendingIntent.getBroadcast(ctx, 1, new Intent(ctx, PowerReceiver.Stop.class), PendingIntent.FLAG_UPDATE_CURRENT);
    b.addAction(android.R.drawable.ic_menu_close_clear_cancel, "עצור", stop);
  }

  // הודעת מצב מהמחשב: בזמן ההכנה — התראה קבועה עם פס "עובד…"; שגיאה — התראה רגילה
  static void notifyMsg(Context ctx, Status s) {
    NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    Notification.Builder b = builder(ctx, nm).setContentTitle(s.title).setContentText(s.text);
    if (Build.VERSION.SDK_INT >= 16) b.setStyle(new Notification.BigTextStyle().bigText(s.text));
    if (s.error) {
      nm.cancel(ID);
      b.setSmallIcon(android.R.drawable.stat_notify_error).setAutoCancel(true);
    } else {
      b.setSmallIcon(android.R.drawable.stat_sys_download).setProgress(0, 0, true).setOngoing(true);
      stopAction(ctx, b, s);
    }
    nm.notify(ID, b.build());
  }

  static void cancel(Context ctx) {
    ((NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(ID);
  }

  static void notifyStatus(Context ctx, Status s) {
    NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    Notification.Builder b = builder(ctx, nm);
    if (s.active) {
      b.setSmallIcon(android.R.drawable.stat_sys_download)
          .setContentTitle("מעתיק סרטונים מהמחשב")
          .setContentText(s.done + " מתוך " + s.total + " · אל תנתקו את הנגן")
          .setProgress(s.total, s.done, false)
          .setOngoing(true);
      stopAction(ctx, b, s);
    } else {
      nm.cancel(ID); // התראה חדשה (עם צליל) — לא רק עדכון של זו שמתקדמת
      b.setSmallIcon(android.R.drawable.stat_sys_download_done)
          .setContentTitle("הנגן מעודכן ✓")
          .setContentText(s.videos > 0 ? "נוספו " + s.videos + " סרטונים חדשים · לחצו לצפייה" : "אין סרטונים חדשים")
          .setAutoCancel(true);
    }
    nm.notify(ID, b.build());
  }

  static void notifyStopped(Context ctx, Status s) {
    NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, CHANNEL) : new Notification.Builder(ctx);
    nm.notify(ID, b.setSmallIcon(android.R.drawable.stat_notify_error)
        .setContentTitle("ההעתקה נעצרה")
        .setContentText("הועתקו " + s.done + " מתוך " + s.total + ". חברו שוב למחשב כדי להשלים.")
        .setAutoCancel(true).build());
  }

  // ---- מעקב: כל שנייה וחצי, כל עוד הנגן מחובר לחשמל/מחשב (עד maxMs) ----
  private static final java.util.concurrent.atomic.AtomicBoolean watching = new java.util.concurrent.atomic.AtomicBoolean();

  // רק מעקב אחד בכל רגע (גם החיבור לחשמל וגם ה-JobScheduler יכולים להפעיל אותו)
  // אם כבר יש מעקב — מחכים שיסתיים (ולא חוזרים מיד, אחרת ה-JobScheduler מריץ את העבודה שוב ושוב)
  static void watch(Context ctx, long maxMs) {
    long end = System.currentTimeMillis() + maxMs;
    while (!watching.compareAndSet(false, true)) {
      if (System.currentTimeMillis() > end || !charging(ctx)) return;
      try { Thread.sleep(5000); } catch (InterruptedException e) { return; }
    }
    NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    log(ctx, "watch start, charging=" + charging(ctx) + ", notifications=" + (Build.VERSION.SDK_INT >= 24 ? nm.areNotificationsEnabled() : true));
    try { watchLoop(ctx, end - System.currentTimeMillis()); }
    catch (Throwable t) { log(ctx, "watch error: " + t); }
    finally { watching.set(false); log(ctx, "watch end, charging=" + charging(ctx)); }
  }

  private static void watchLoop(Context ctx, long maxMs) {
    android.content.SharedPreferences prefs = ctx.getSharedPreferences("sync", Context.MODE_PRIVATE);
    long end = System.currentTimeMillis() + maxMs, seen = prefs.getLong("announced", 0);
    Status last = null;
    String shown = null; // הודעת המצב שמוצגת עכשיו (כותרת+טקסט), כדי לא לעדכן סתם
    while (System.currentTimeMillis() < end) {
      Status s = read(ctx);
      if (s.msg) {
        String key = s.id + s.title + s.text + s.stopping;
        if (s.active || (s.error && s.id > prefs.getLong("error", 0))) {
          if (!key.equals(shown)) { notifyMsg(ctx, s); shown = key; log(ctx, "notify msg: " + s.title + " / " + s.text); }
          if (s.error) prefs.edit().putLong("error", s.id).apply();
        } else if (shown != null && !s.error) { cancel(ctx); shown = null; } // המחשב הפסיק לשלוח
        if (!charging(ctx)) { if (s.active) cancel(ctx); return; }
        try { Thread.sleep(1500); } catch (InterruptedException e) { return; }
        continue;
      }
      shown = null;
      if (s.id > seen && (s.active || s.finished)) {
        if (last == null || last.finished != s.finished) log(ctx, "notify copy: " + s.json());
        notifyStatus(ctx, s);
        last = s;
        if (s.finished) { seen = s.id; prefs.edit().putLong("announced", seen).apply(); last = null; }
      } else if (s.stalled && last != null && last.id == s.id) {
        notifyStopped(ctx, last); last = null;
      }
      if (!charging(ctx)) {
        if (last != null && last.active) notifyStopped(ctx, last);
        return;
      }
      try { Thread.sleep(1500); } catch (InterruptedException e) { return; }
    }
  }

  private static long stamp(File f) {
    try { return Long.parseLong(f.getName().replaceAll("\\D", "")); } catch (Exception e) { return 0; }
  }

  static String read(File f) throws Exception {
    try (InputStream in = new FileInputStream(f)) {
      byte[] buf = new byte[(int) f.length()];
      int off = 0, n;
      while (off < buf.length && (n = in.read(buf, off, buf.length - off)) > 0) off += n;
      return new String(buf, 0, off, "UTF-8");
    }
  }
}
