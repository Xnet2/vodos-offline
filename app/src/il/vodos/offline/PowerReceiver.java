package il.vodos.offline;

import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

// אנדרואיד 4.4 (בלי JobScheduler): ההודעה "התחבר לחשמל" מפעילה את המעקב אחרי ההעתקה
public class PowerReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context ctx, Intent intent) {
    if (Build.VERSION.SDK_INT < 21) ctx.startService(new Intent(ctx, Watch.class));
  }

  public static class Watch extends Service {
    private volatile boolean running;

    @Override
    public int onStartCommand(Intent intent, int flags, int id) {
      if (!running) {
        running = true;
        new Thread(() -> { Sync.watch(this, 60 * 60 * 1000); running = false; stopSelf(); }).start();
      }
      return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
  }
}
