package il.vodos.offline;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

// משתף סרטון מהתיקייה של האפליקציה עם אפליקציה אחרת (כפתור "שיתוף"):
// content://il.vodos.offline.files/<שם הקובץ> — קריאה בלבד, ורק למי שקיבל הרשאה בשיתוף עצמו
public class Files extends ContentProvider {
  static final String AUTHORITY = "il.vodos.offline.files";

  static Uri uri(String name) { return Uri.parse("content://" + AUTHORITY + "/" + Uri.encode(name)); }

  private File find(Uri uri) throws FileNotFoundException {
    String name = uri.getLastPathSegment();
    if (name == null || name.contains("/") || name.startsWith(".")) throw new FileNotFoundException();
    for (File dir : getContext().getExternalFilesDirs(null)) {
      if (dir == null) continue;
      File f = new File(dir, name);
      if (f.isFile()) return f;
    }
    throw new FileNotFoundException(name);
  }

  @Override public boolean onCreate() { return true; }

  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    return ParcelFileDescriptor.open(find(uri), ParcelFileDescriptor.MODE_READ_ONLY);
  }

  @Override
  public Cursor query(Uri uri, String[] projection, String sel, String[] args, String sort) {
    MatrixCursor c = new MatrixCursor(new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
    try { File f = find(uri); c.addRow(new Object[] { f.getName(), f.length() }); } catch (FileNotFoundException e) {}
    return c;
  }

  @Override
  public String getType(Uri uri) {
    String n = String.valueOf(uri.getLastPathSegment()).toLowerCase();
    return n.endsWith(".webm") ? "video/webm" : n.endsWith(".mov") ? "video/quicktime" : "video/mp4";
  }

  @Override public Uri insert(Uri uri, ContentValues v) { return null; }
  @Override public int delete(Uri uri, String s, String[] a) { return 0; }
  @Override public int update(Uri uri, ContentValues v, String s, String[] a) { return 0; }
}
