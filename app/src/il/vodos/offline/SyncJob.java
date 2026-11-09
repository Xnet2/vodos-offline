package il.vodos.offline;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

// אנדרואיד 5 ומעלה: עבודה שהמערכת מפעילה כשהנגן מתחבר לחשמל/למחשב.
// היא עוקבת אחרי ההעתקה ומקפיצה התראות, ובסוף מתזמנת את עצמה שוב לחיבור הבא
// (אם הנגן עדיין מחובר — היא פשוט רצה שוב מיד, כך שהמעקב נמשך כל זמן החיבור).
public class SyncJob extends JobService {
  private static final int JOB = 1;

  static void schedule(Context ctx) {
    JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
    js.schedule(new JobInfo.Builder(JOB, new ComponentName(ctx, SyncJob.class))
        .setRequiresCharging(true)
        .setPersisted(true) // נשאר גם אחרי הפעלה מחדש של הנגן
        .build());
  }

  @Override
  public boolean onStartJob(final JobParameters params) {
    Sync.log(this, "job start");
    new Thread(() -> {
      Sync.watch(SyncJob.this, 9 * 60 * 1000); // מערכת ההפעלה מגבילה עבודה ל-10 דקות
      jobFinished(params, false);
      schedule(SyncJob.this);
    }).start();
    return true;
  }

  @Override
  public boolean onStopJob(JobParameters params) {
    return true; // המערכת עצרה (למשל נותק) — לתזמן שוב
  }
}
