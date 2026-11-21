package il.vodos.offline;

import android.content.Context;
import android.os.Build;
import android.os.Environment;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

// התיקיות שבהן נמצאים הקבצים מהמחשב (סרטונים, index, sync, status) ומה שהאפליקציה כותבת למחשב (state, stop).
// בדרך כלל: Android/data/il.vodos.offline/files, בזיכרון הפנימי ובכרטיס.
// בנגן עם אנדרואיד 11 ומעלה בלי כרטיס זיכרון, Windows לא מצליח לכתוב ל-Android/data — שם יש גם תיקייה גלויה
// VODOS בשורש הזיכרון הפנימי (עם vodos.txt, שלפיו התוכנה במחשב מזהה אותה). צריך הרשאת אחסון.
final class Dirs {
  static File[] all(Context ctx) {
    List<File> out = new ArrayList<>();
    for (File d : ctx.getExternalFilesDirs(null)) if (d != null) out.add(d);
    File pub = publicDir();
    if (pub.isDirectory() && pub.canRead()) out.add(pub);
    return out.toArray(new File[0]);
  }

  static File publicDir() { return new File(Environment.getExternalStorageDirectory(), "VODOS"); }

  // האם צריך את התיקייה הגלויה: אנדרואיד 11+ (שם Windows חסום מ-Android/data בחלק מהמכשירים) ובלי כרטיס זיכרון
  static boolean needPublic(Context ctx) {
    if (Build.VERSION.SDK_INT < 30) return false;
    int n = 0;
    for (File d : ctx.getExternalFilesDirs(null)) if (d != null) n++;
    return n < 2;
  }
}
