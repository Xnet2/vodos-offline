package il.vodos.offline;

import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

// ההודעה "התחבר לחשמל/למחשב" מפעילה מיד את המעקב אחרי ההעתקה — בלי לפתוח את האפליקציה.
// (targetSdk 25 — כך אנדרואיד עדיין שולח את ההודעה הזו לאפליקציה שסגורה, ומרשה לה לרוץ ברקע.
//  ה-JobScheduler נשאר כגיבוי, אבל אנדרואיד דוחה אותו באפליקציות שלא נפתחו לאחרונה.)
public class PowerReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context ctx, Intent intent) {
    Sync.log(ctx, "receiver: " + intent.getAction());
    Sync.markConnect(ctx);
    try { ctx.startService(new Intent(ctx, Watch.class)); } catch (Exception e) { Sync.log(ctx, "startService failed: " + e); }
  }

  // הכפתור "עצור" בהתראה
  public static class Stop extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) { Sync.requestStop(ctx); }
  }

  // המעקב רץ כ"שירות קדמי" (עם ההתראה "הנגן מחובר") — אחרת אנדרואיד הורג את האפליקציה ברקע אחרי כמה שניות,
  // עוד לפני שהמחשב מתחיל להעתיק. בסוף (הנגן מעודכן / נעצר / נותק) ההתראה הקבועה יורדת
  public static class Watch extends Service {
    private volatile boolean running;

    @Override
    public int onStartCommand(Intent intent, int flags, int id) {
      if (!running) {
        running = true;
        startForeground(Sync.ID, Sync.connectedNotification(this));
        new Thread(() -> {
          try { Thread.sleep(2000); } catch (InterruptedException e) {}
          // מטען קיר (לא מחשב) — אין מה לחכות לו
          if (Sync.usb(this)) Sync.watch(this, 60 * 60 * 1000, () -> stopForeground(true));
          else Sync.log(this, "not usb — no watch");
          stopForeground(true);
          running = false; stopSelf();
        }).start();
      }
      return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
  }
}
