package il.vodos.offline;

import android.app.Activity;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

// VODOS לנגן: מסך מלא עם הפיד (assets/index.html), שמנגן את הסרטונים שתוכנת הסנכרון במחשב
// העתיקה לתיקייה של האפליקציה: Android/data/il.vodos.offline/files (בכרטיס הזיכרון או בזיכרון הפנימי).
public class MainActivity extends Activity {
  private WebView web;
  private FrameLayout root;
  private ImageView splash;
  private final Handler ui = new Handler();
  private volatile String status;
  private volatile boolean resumed;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    // קודם הלוגו, מיד — יצירת ה-WebView לוקחת שנייה-שתיים בנגן, ובלי זה רואים מסך שחור
    root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);
    splash = new ImageView(this);
    try (InputStream in = getAssets().open("logo.png")) { splash.setImageBitmap(BitmapFactory.decodeStream(in)); } catch (Exception e) {}
    int w = getResources().getDisplayMetrics().widthPixels / 2;
    root.addView(splash, new FrameLayout.LayoutParams(w, w, Gravity.CENTER));
    setContentView(root);
    ui.post(this::createWeb);
    new Thread(this::markFolders).start();
    if (Build.VERSION.SDK_INT >= 21) SyncJob.schedule(this); // התראות כשמחברים למחשב
  }

  private void createWeb() {
    web = new WebView(this);
    web.setBackgroundColor(Color.BLACK);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setAllowFileAccess(true);
    s.setAllowFileAccessFromFileURLs(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    web.addJavascriptInterface(new Bridge(), "VODOS");
    web.setWebViewClient(new WebViewClient() {
      @Override public void onPageFinished(WebView v, String url) {
        if (splash != null) { root.removeView(splash); splash = null; }
      }
    });
    root.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
    web.loadUrl("file:///android_asset/index.html");
  }

  // יוצר את התיקייה של האפליקציה (בזיכרון הפנימי ובכרטיס) עם קובץ סימון, ומודיע עליו למערכת —
  // כך התוכנה במחשב רואה אותה דרך USB ויודעת שזה מכשיר עם VODOS
  private void markFolders() {
    for (File dir : getExternalFilesDirs(null)) {
      if (dir == null) continue;
      File mark = new File(dir, "vodos.txt");
      try { if (!mark.exists()) new FileOutputStream(mark).close(); } catch (Exception e) { continue; }
      MediaScannerConnection.scanFile(this, new String[] { mark.getPath() }, null, null);
    }
  }

  // מצב ההעתקה נבדק ברקע (סריקת התיקייה בכרטיס איטית — לא על חשבון הגלילה):
  // כל שנייה וחצי בזמן העתקה, אחרת כל 6 שניות, ורק כשהאפליקציה פתוחה
  private final Runnable pollStatus = new Runnable() {
    @Override public void run() {
      if (!resumed) return;
      new Thread(() -> {
        Sync.Status st = Sync.read(MainActivity.this);
        status = st.json();
        ui.postDelayed(pollStatus, st.active ? 1500 : 6000);
      }).start();
    }
  };

  @Override
  protected void onResume() { super.onResume(); resumed = true; ui.removeCallbacks(pollStatus); ui.post(pollStatus); }

  @Override
  protected void onPause() {
    super.onPause();
    resumed = false;
    if (web != null) web.evaluateJavascript("window.vodosPause&&vodosPause()", null);
  }

  @Override
  public void onBackPressed() {
    if (web == null) { finish(); return; }
    web.evaluateJavascript("window.vodosBack?vodosBack():false", v -> { if (!"true".equals(v)) finish(); });
  }

  class Bridge {
    // מחזיר את רשימת הסרטונים העדכנית: {"base":"file:///…/files/","index":{…}}
    // סרטונים שסומנו "אהבתי" נשארים גם אם הם כבר לא ברשימה מהמחשב.
    // הניקוי (רשימות ישנות וסרטונים שכבר לא ברשימה) נעשה ברקע, כדי שהפיד ייפתח מהר
    @JavascriptInterface
    public String index() {
      File best = null, bestDir = null;
      for (File dir : getExternalFilesDirs(null)) {
        if (dir == null) continue;
        File[] list = dir.listFiles();
        if (list == null) continue;
        for (File f : list) {
          if (f.getName().matches("index-\\d+\\.json") && (best == null || stamp(f) > stamp(best))) { best = f; bestDir = dir; }
        }
      }
      if (best == null) return "{}";
      try {
        JSONObject index = new JSONObject(read(best));
        JSONArray videos = index.optJSONArray("videos");
        if (videos == null) index.put("videos", videos = new JSONArray());
        final Set<String> keep = new HashSet<>();
        keep.add(best.getName());
        for (int i = 0; i < videos.length(); i++) keep.add(videos.getJSONObject(i).optString("f"));
        JSONObject sources = index.optJSONObject("sources");
        if (sources != null) for (java.util.Iterator<String> it = sources.keys(); it.hasNext(); ) keep.add(sources.getJSONObject(it.next()).optString("avatar"));
        JSONArray likes = likes(bestDir);
        for (int i = 0; i < likes.length(); i++) {
          JSONObject v = likes.getJSONObject(i);
          String f = v.optString("f");
          if (!keep.contains(f) && new File(bestDir, f).exists()) { videos.put(v); keep.add(f); }
        }
        // גם מה שבדרך מהמחשב (או נשאר מהעתקה שנקטעה) — לא למחוק
        File sync = Sync.newestSync(MainActivity.this);
        if (sync != null) {
          keep.add(sync.getName());
          try {
            JSONArray files = new JSONObject(Sync.read(sync)).getJSONArray("files");
            for (int i = 0; i < files.length(); i++) keep.add(files.getString(i));
          } catch (Exception e) {}
        }
        File st = Sync.newest(MainActivity.this, "status");
        if (st != null) keep.add(st.getName());
        final File dir = bestDir;
        filesDir = dir;
        new Thread(() -> {
          File[] list = dir.listFiles();
          if (list != null) for (File f : list) {
            String n = f.getName();
            if (f.isFile() && !keep.contains(n) && (n.startsWith("index-") || n.startsWith("sync-") || n.startsWith("status-") || n.startsWith("stop-") || n.matches(".+\\.(mp4|mov|m4v|webm|png|jpg|jpeg|webp|gif)"))) f.delete();
          }
          // עותקים באחסון השני (למשל בזיכרון הפנימי, כשהמחשב בחר בו בטעות) — כפולים או ישנים, נמחקים
          for (File other : getExternalFilesDirs(null)) {
            if (other == null || other.equals(dir)) continue;
            File[] ol = other.listFiles();
            if (ol != null) for (File f : ol) {
              String n = f.getName();
              boolean media = n.matches(".+\\.(mp4|mov|m4v|webm|png|jpg|jpeg|webp|gif)");
              boolean ctl = n.startsWith("index-") || n.startsWith("sync-") || n.startsWith("status-") || n.startsWith("stop-");
              if (f.isFile() && ((media && (!keep.contains(n) || new File(dir, n).exists())) || (ctl && !keep.contains(n)))) f.delete();
            }
          }
          // תמונות קטנות של סרטונים שכבר נמחקו
          File[] th = thumbs().listFiles();
          if (th != null) for (File f : th) if (!keep.contains(f.getName().replaceAll("\\.jpg(\\.tmp)?$", ""))) f.delete();
        }).start();
        return "{\"base\":" + JSONObject.quote(Uri.fromFile(bestDir).toString() + "/") + ",\"index\":" + index + "}";
      } catch (Exception e) {
        return "{}";
      }
    }

    // מצב ההעתקה מהמחשב, לפס ההתקדמות בפיד: {"active":…,"finished":…,"done":…,"total":…,"videos":…,"id":…}
    @JavascriptInterface
    public String status() {
      if (status == null) status = Sync.read(MainActivity.this).json(); // בטעינה הראשונה — מיד
      return status;
    }

    // מה שהמחשב צריך לדעת מהנגן: אהבתי, מה נצפה, וההגדרות. נשמר כ-state-<זמן>.json בכל תיקייה של האפליקציה;
    // התוכנה במחשב קוראת את החדש ביותר בחיבור הבא
    @JavascriptInterface
    public void saveState(final String json) {
      new Thread(() -> {
        String name = "state-" + System.currentTimeMillis() + ".json";
        for (File dir : getExternalFilesDirs(null)) {
          if (dir == null) continue;
          List<String> scan = new ArrayList<>();
          File out = new File(dir, name);
          try (FileOutputStream o = new FileOutputStream(out)) { o.write(json.getBytes("UTF-8")); } catch (Exception e) { continue; }
          scan.add(out.getPath());
          File[] list = dir.listFiles();
          if (list != null) for (File f : list) {
            if (f.getName().matches("state-\\d+\\.json") && !f.getName().equals(name) && f.delete()) scan.add(f.getPath());
          }
          MediaScannerConnection.scanFile(MainActivity.this, scan.toArray(new String[0]), null, null);
        }
      }).start();
    }

    // לחלונית ההגדרות: כמה סרטונים ונפח בנגן, וכמה מקום פנוי — {"count":…,"used":…,"free":…}
    @JavascriptInterface
    public String storage() {
      File dir = filesDir;
      if (dir == null) return "{}";
      long used = 0; int count = 0;
      File[] list = dir.listFiles();
      if (list != null) for (File f : list) if (f.getName().matches(".+\\.(mp4|mov|m4v|webm)")) { used += f.length(); count++; }
      return "{\"count\":" + count + ",\"used\":" + used + ",\"free\":" + dir.getUsableSpace() + "}";
    }

    // תמונה קטנה מתוך סרטון, לרשת הסרטונים בחלונית הערוץ. אם עוד אין — מכינים ברקע ומחזירים ""
    @JavascriptInterface
    public String thumb(String f) {
      if (filesDir == null || f.contains("/")) return "";
      File out = new File(thumbs(), f + ".jpg");
      if (out.length() > 0) return Uri.fromFile(out).toString();
      synchronized (pending) {
        if (pending.add(f)) thumbQueue.execute(() -> makeThumb(new File(filesDir, f), out));
      }
      return "";
    }

    // שיתוף הסרטון עצמו (לא קישור — אין אינטרנט) דרך חלון השיתוף של אנדרואיד
    @JavascriptInterface
    public void share(String f, String text) {
      if (f == null || f.contains("/")) return;
      Intent send = new Intent(Intent.ACTION_SEND)
          .setType("video/mp4")
          .putExtra(Intent.EXTRA_STREAM, Files.uri(f))
          .putExtra(Intent.EXTRA_TEXT, text == null ? "" : text)
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      runOnUiThread(() -> {
        try { startActivity(Intent.createChooser(send, "שיתוף סרטון")); }
        catch (Exception e) { js("window.vodosSaved&&vodosSaved(" + JSONObject.quote(f) + ",'noshare')"); }
      });
    }

    // הורדה לגלריה: עותק ב-Movies/VODOS (בקשת הרשאה בפעם הראשונה). התשובה חוזרת ל-vodosSaved(f, 'ok'|'denied'|'fail')
    @JavascriptInterface
    public void download(String f) {
      if (f == null || f.contains("/")) return;
      runOnUiThread(() -> {
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
          pendingDownload = f;
          requestPermissions(new String[] { android.Manifest.permission.WRITE_EXTERNAL_STORAGE }, 7);
        } else saveToGallery(f);
      });
    }

    // עצירת העדכון מהמחשב (גם מהכפתור בהתראה)
    @JavascriptInterface
    public void stopSync() { Sync.requestStop(MainActivity.this); }

    @JavascriptInterface
    public String version() {
      try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return ""; }
    }

    @JavascriptInterface
    public void immersive() {
      runOnUiThread(() -> web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY));
    }
  }

  private String pendingDownload;

  private void js(String code) { runOnUiThread(() -> { if (web != null) web.evaluateJavascript(code, null); }); }

  @Override
  public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
    if (code != 7 || pendingDownload == null) return;
    String f = pendingDownload; pendingDownload = null;
    if (res.length > 0 && res[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) saveToGallery(f);
    else js("window.vodosSaved&&vodosSaved(" + JSONObject.quote(f) + ",'denied')");
  }

  private void saveToGallery(final String f) {
    new Thread(() -> {
      String result = "fail";
      try {
        File src = null;
        for (File d : getExternalFilesDirs(null)) if (d != null && new File(d, f).isFile()) src = new File(d, f);
        File dir = new File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_MOVIES), "VODOS");
        dir.mkdirs();
        File out = new File(dir, f);
        if (src != null) {
          if (out.length() != src.length()) {
            try (InputStream in = new FileInputStream(src); FileOutputStream o = new FileOutputStream(out)) {
              byte[] buf = new byte[1 << 16]; int n;
              while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
            }
          }
          MediaScannerConnection.scanFile(this, new String[] { out.getPath() }, null, null);
          result = "ok";
        }
      } catch (Exception e) {}
      js("window.vodosSaved&&vodosSaved(" + JSONObject.quote(f) + ",'" + result + "')");
    }).start();
  }

  private volatile File filesDir; // התיקייה שבה הסרטונים (נקבעת ב-index)
  private final Set<String> pending = new HashSet<>();
  private final java.util.concurrent.ExecutorService thumbQueue = java.util.concurrent.Executors.newSingleThreadExecutor();

  private File thumbs() {
    File d = new File(getCacheDir(), "thumbs");
    d.mkdirs();
    return d;
  }

  // פריים מהשנייה הראשונה, ברוחב 200 — מספיק לרשת של 3 עמודות
  private void makeThumb(File video, File out) {
    android.media.MediaMetadataRetriever r = new android.media.MediaMetadataRetriever();
    try {
      r.setDataSource(video.getPath());
      android.graphics.Bitmap b = r.getFrameAtTime(1000000, android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
      if (b == null) return;
      int w = 200, h = Math.max(1, b.getHeight() * w / Math.max(1, b.getWidth()));
      android.graphics.Bitmap s = android.graphics.Bitmap.createScaledBitmap(b, w, h, true);
      File tmp = new File(out.getPath() + ".tmp");
      try (FileOutputStream o = new FileOutputStream(tmp)) { s.compress(android.graphics.Bitmap.CompressFormat.JPEG, 72, o); }
      tmp.renameTo(out);
      if (s != b) s.recycle();
      b.recycle();
    } catch (Exception e) {
    } finally {
      try { r.release(); } catch (Exception e) {}
    }
  }

  // הסרטונים שסומנו "אהבתי", מקובץ ה-state האחרון: [{f,s,t,ts}, …]
  private static JSONArray likes(File dir) {
    File best = null;
    File[] list = dir.listFiles();
    if (list != null) for (File f : list) if (f.getName().matches("state-\\d+\\.json") && (best == null || stamp(f) > stamp(best))) best = f;
    try { return new JSONObject(read(best)).getJSONArray("likes"); } catch (Exception e) { return new JSONArray(); }
  }

  private static long stamp(File f) {
    try { return Long.parseLong(f.getName().replaceAll("\\D", "")); } catch (Exception e) { return 0; }
  }

  private static String read(File f) throws Exception {
    try (InputStream in = new FileInputStream(f)) {
      byte[] buf = new byte[(int) f.length()];
      int off = 0, n;
      while (off < buf.length && (n = in.read(buf, off, buf.length - off)) > 0) off += n;
      return new String(buf, 0, off, "UTF-8");
    }
  }
}
