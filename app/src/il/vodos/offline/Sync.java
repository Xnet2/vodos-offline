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
    long id; // הזמן של קובץ ה-sync — מזהה את ההעתקה

    String json() {
      return "{\"active\":" + active + ",\"finished\":" + finished + ",\"done\":" + done + ",\"total\":" + total
          + ",\"videos\":" + videos + ",\"id\":" + id + "}";
    }
  }

  static Status read(Context ctx) {
    Status s = new Status();
    File sync = newestSync(ctx);
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

  static File newestSync(Context ctx) {
    File sync = null;
    for (File dir : ctx.getExternalFilesDirs(null)) {
      if (dir == null) continue;
      File[] list = dir.listFiles();
      if (list == null) continue;
      for (File f : list) if (f.getName().matches("sync-\\d+\\.json") && (sync == null || stamp(f) > stamp(sync))) sync = f;
    }
    return sync;
  }

  static boolean charging(Context ctx) {
    Intent b = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
    return b != null && b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0;
  }

  // ---- התראות ----
  private static final String CHANNEL = "sync";
  private static final int ID = 1;

  static void notifyStatus(Context ctx, Status s) {
    NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    Notification.Builder b;
    if (Build.VERSION.SDK_INT >= 26) {
      nm.createNotificationChannel(new NotificationChannel(CHANNEL, "העתקה מהמחשב", NotificationManager.IMPORTANCE_HIGH));
      b = new Notification.Builder(ctx, CHANNEL);
    } else {
      b = new Notification.Builder(ctx).setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_SOUND);
    }
    PendingIntent open = PendingIntent.getActivity(ctx, 0,
        new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_UPDATE_CURRENT);
    b.setContentIntent(open).setOnlyAlertOnce(true);
    if (s.active) {
      b.setSmallIcon(android.R.drawable.stat_sys_download)
          .setContentTitle("מעתיק סרטונים מהמחשב")
          .setContentText(s.done + " מתוך " + s.total + " · אל תנתקו את הנגן")
          .setProgress(s.total, s.done, false)
          .setOngoing(true);
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
  static void watch(Context ctx, long maxMs) {
    android.content.SharedPreferences prefs = ctx.getSharedPreferences("sync", Context.MODE_PRIVATE);
    long end = System.currentTimeMillis() + maxMs, seen = prefs.getLong("announced", 0);
    Status last = null;
    while (System.currentTimeMillis() < end) {
      Status s = read(ctx);
      if (s.id > seen && (s.active || s.finished)) {
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
