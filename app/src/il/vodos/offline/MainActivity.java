package il.vodos.offline;

import android.app.Activity;
import android.graphics.Color;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// VODOS לנגן: מסך מלא עם הפיד (assets/index.html), שמנגן את הסרטונים שתוכנת הסנכרון במחשב
// העתיקה לתיקייה של האפליקציה: Android/data/il.vodos.offline/files (בכרטיס הזיכרון או בזיכרון הפנימי).
public class MainActivity extends Activity {
  private WebView web;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    web = new WebView(this);
    web.setBackgroundColor(Color.BLACK);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setAllowFileAccess(true);
    s.setAllowFileAccessFromFileURLs(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    web.addJavascriptInterface(new Bridge(), "VODOS");
    web.loadUrl("file:///android_asset/index.html");
    setContentView(web);
    markFolders();
    if (Build.VERSION.SDK_INT >= 21) SyncJob.schedule(this); // התראות כשמחברים למחשב
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

  @Override
  protected void onPause() { super.onPause(); web.evaluateJavascript("window.vodosPause&&vodosPause()", null); }

  @Override
  public void onBackPressed() {
    web.evaluateJavascript("window.vodosBack?vodosBack():false", v -> { if (!"true".equals(v)) finish(); });
  }

  class Bridge {
    // מחזיר את רשימת הסרטונים העדכנית: {"base":"file:///…/files/","index":{…}}
    // ובדרך מנקה רשימות ישנות וסרטונים שכבר לא ברשימה (כדי שהנגן לא יתמלא)
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
        String json = read(best);
        Set<String> keep = new HashSet<>();
        keep.add(best.getName());
        Matcher m = Pattern.compile("\"(?:f|avatar)\":\"([^\"]+)\"").matcher(json);
        while (m.find()) keep.add(m.group(1));
        // גם מה שבדרך מהמחשב (או נשאר מהעתקה שנקטעה) — לא למחוק
        File sync = Sync.newestSync(MainActivity.this);
        if (sync != null) {
          keep.add(sync.getName());
          Matcher sm = Pattern.compile("\"([^\"]+)\"").matcher(Sync.read(sync));
          while (sm.find()) keep.add(sm.group(1));
        }
        File[] list = bestDir.listFiles();
        if (list != null) for (File f : list) {
          String n = f.getName();
          if (f.isFile() && !keep.contains(n) && (n.startsWith("index-") || n.startsWith("sync-") || n.matches(".+\\.(mp4|mov|m4v|webm|png|jpg|jpeg|webp|gif)"))) f.delete();
        }
        return "{\"base\":" + quote(Uri.fromFile(bestDir).toString() + "/") + ",\"index\":" + json + "}";
      } catch (Exception e) {
        return "{}";
      }
    }

    // מצב ההעתקה מהמחשב, לפס ההתקדמות בפיד: {"active":…,"finished":…,"done":…,"total":…,"videos":…,"id":…}
    @JavascriptInterface
    public String status() { return Sync.read(MainActivity.this).json(); }

    @JavascriptInterface
    public void immersive() {
      runOnUiThread(() -> web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY));
    }
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

  private static String quote(String s) {
    return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
  }
}
