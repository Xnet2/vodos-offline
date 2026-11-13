package il.vodos.online;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.media.MediaMetadataRetriever;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
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

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.LinkedBlockingDeque;

// VODOS אונליין: אותו מסך כמו VODOS לנגן (assets/index.html), אבל הרשימה נטענת ישר מהאתר וכל סרטון
// מנוגן מהכתובת שלו — בלי מחשב ובלי סרטונים בנגן. כאן רק מה שהמסך צריך מאנדרואיד: תמונות קטנות, שיתוף והורדה
public class MainActivity extends Activity {
  private WebView web;
  private FrameLayout root;
  private ImageView splash;
  private final Handler ui = new Handler();

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
    for (int i = 0; i < 2; i++) new Thread(this::thumbWorker).start();
    new Thread(this::trimThumbs).start();
  }

  private void createWeb() {
    web = new WebView(this);
    web.setBackgroundColor(Color.BLACK);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setAllowFileAccess(true);
    // הדף נטען מהאפליקציה (file://) וקורא את הרשימה מהאתר ומ-Google Sheets
    s.setAllowUniversalAccessFromFileURLs(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    if (Build.VERSION.SDK_INT >= 21) s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    web.addJavascriptInterface(new Bridge(), "VODOS");
    web.setWebViewClient(new WebViewClient() {
      @Override public void onPageFinished(WebView v, String url) {
        if (splash != null) { root.removeView(splash); splash = null; }
      }
    });
    root.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
    web.loadUrl("file:///android_asset/index.html");
  }

  @Override
  protected void onPause() {
    super.onPause();
    if (web != null) web.evaluateJavascript("window.vodosPause&&vodosPause()", null);
  }

  @Override
  public void onBackPressed() {
    if (web == null) { finish(); return; }
    web.evaluateJavascript("window.vodosBack?vodosBack():false", v -> { if (!"true".equals(v)) finish(); });
  }

  class Bridge {
    // המסך שואל אם זו הגרסה האונליין — אז הוא טוען את הרשימה מהאתר בעצמו
    @JavascriptInterface
    public boolean online() { return true; }

    // תמונה קטנה מתוך סרטון (לפי הכתובת שלו), לרשתות הסרטונים. אם עוד אין — מכינים ברקע ומחזירים ""
    @JavascriptInterface
    public String thumb(String url) {
      if (url == null || !url.startsWith("http")) return "";
      File out = new File(thumbs(), hash(url) + ".jpg");
      if (out.length() > 0) return Uri.fromFile(out).toString();
      synchronized (pending) { if (!failed.contains(url) && pending.add(url)) thumbQueue.offerLast(url); }
      return "";
    }

    // שיתוף: הטקסט עם הקישור לסרטון
    @JavascriptInterface
    public void share(String url, String text) {
      Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain")
          .putExtra(Intent.EXTRA_TEXT, (text == null ? "" : text + "\n") + url);
      runOnUiThread(() -> {
        try { startActivity(Intent.createChooser(send, "שיתוף סרטון")); }
        catch (Exception e) { js("window.vodosSaved&&vodosSaved(" + JSONObject.quote(url) + ",'noshare')"); }
      });
    }

    // הורדה לגלריה (Movies/VODOS) — רק כשלוחצים "הורדה". התשובה חוזרת ל-vodosSaved(url, 'ok'|'denied'|'fail')
    @JavascriptInterface
    public void download(String url) {
      if (url == null || !url.startsWith("http")) return;
      runOnUiThread(() -> {
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
          pendingDownload = url;
          requestPermissions(new String[] { android.Manifest.permission.WRITE_EXTERNAL_STORAGE }, 7);
        } else saveToGallery(url);
      });
    }

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
    String url = pendingDownload; pendingDownload = null;
    if (res.length > 0 && res[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) saveToGallery(url);
    else js("window.vodosSaved&&vodosSaved(" + JSONObject.quote(url) + ",'denied')");
  }

  private void saveToGallery(final String url) {
    new Thread(() -> {
      String result = "fail";
      HttpURLConnection c = null;
      try {
        String name = Uri.parse(url).getLastPathSegment();
        if (name == null || !name.matches("[\\w.-]+\\.(mp4|mov|m4v|webm)")) name = hash(url) + ".mp4";
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), "VODOS");
        dir.mkdirs();
        File out = new File(dir, name), tmp = new File(dir, name + ".part");
        c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000); c.setReadTimeout(60000);
        c.setRequestProperty("User-Agent", "Mozilla/5.0 VODOS-online");
        if (c.getResponseCode() / 100 != 2) throw new Exception("HTTP " + c.getResponseCode());
        try (InputStream in = c.getInputStream(); FileOutputStream o = new FileOutputStream(tmp)) {
          byte[] buf = new byte[1 << 16]; int n;
          while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
        }
        if (!tmp.renameTo(out)) throw new Exception("rename");
        MediaScannerConnection.scanFile(this, new String[] { out.getPath() }, null, null);
        result = "ok";
      } catch (Exception e) {
      } finally { if (c != null) c.disconnect(); }
      js("window.vodosSaved&&vodosSaved(" + JSONObject.quote(url) + ",'" + result + "')");
    }).start();
  }

  // ---- תמונות קטנות: פריים מהשנייה הראשונה של הסרטון ברשת, ברוחב 200 ----
  // הבקשה האחרונה קודם (מה שעל המסך עכשיו), שני תהליכים במקביל
  private final Set<String> pending = new HashSet<>(), failed = new HashSet<>(); // failed — לא לנסות שוב ושוב
  private final LinkedBlockingDeque<String> thumbQueue = new LinkedBlockingDeque<>();

  private void thumbWorker() {
    for (;;) {
      String url;
      try { url = thumbQueue.takeLast(); } catch (InterruptedException e) { return; }
      boolean ok = makeThumb(url, new File(thumbs(), hash(url) + ".jpg"));
      synchronized (pending) { pending.remove(url); if (!ok) failed.add(url); }
    }
  }

  private boolean makeThumb(String url, File out) {
    MediaMetadataRetriever r = new MediaMetadataRetriever();
    try {
      HashMap<String, String> headers = new HashMap<>();
      headers.put("User-Agent", "Mozilla/5.0 VODOS-online");
      r.setDataSource(url, headers);
      Bitmap b = r.getFrameAtTime(1000000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
      if (b == null) b = r.getFrameAtTime();
      if (b == null) return false;
      int w = 200, h = Math.max(1, b.getHeight() * w / Math.max(1, b.getWidth()));
      Bitmap s = Bitmap.createScaledBitmap(b, w, h, true);
      File tmp = new File(out.getPath() + ".tmp");
      try (FileOutputStream o = new FileOutputStream(tmp)) { s.compress(Bitmap.CompressFormat.JPEG, 72, o); }
      tmp.renameTo(out);
      if (s != b) s.recycle();
      b.recycle();
      return true;
    } catch (Exception e) {
      return false;
    } finally {
      try { r.release(); } catch (Exception e) {}
    }
  }

  private File thumbs() {
    File d = new File(getCacheDir(), "thumbs");
    d.mkdirs();
    return d;
  }

  // התמונות הקטנות לא מצטברות: מה שלא נפתח שבוע — נמחק
  private void trimThumbs() {
    File[] list = thumbs().listFiles();
    long old = System.currentTimeMillis() - 7L * 24 * 3600 * 1000;
    if (list != null) for (File f : list) if (f.lastModified() < old) f.delete();
  }

  private static String hash(String s) {
    try {
      byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes("UTF-8"));
      StringBuilder b = new StringBuilder();
      for (int i = 0; i < 10; i++) b.append(String.format("%02x", d[i]));
      return b.toString();
    } catch (Exception e) { return Integer.toHexString(s.hashCode()); }
  }
}
