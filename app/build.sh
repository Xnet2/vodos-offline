#!/bin/sh
# בונה את VODOS.apk בלי Gradle — רק עם JDK 17 וכלי האנדרואיד (build-tools 34, platform 34).
# שימוש (Git Bash):  sh app/build.sh      → VODOS.apk
# BUILD = התיקייה שבה הותקנו הכלים (נתיב באנגלית בלבד; הכלים לא אוהבים נתיבים בעברית)
set -e
BUILD="${BUILD:-C:/Users/F8DF~1/AppData/Local/VODOS-build}"
JAVA_HOME="$(ls -d "$BUILD"/jdk-17* | head -1)"
BT="$(ls -d "$BUILD"/sdk/bt/* | head -1)"
JAR="$BUILD/sdk/pf/android-34/android.jar"
APP="$(cd "$(dirname "$0")" && pwd)"
OUT="$BUILD/out"
rm -rf "$OUT" && mkdir -p "$OUT/res/drawable" "$OUT/assets" "$OUT/classes" "$OUT/dex"

cp "$APP/AndroidManifest.xml" "$OUT/"
cp "$APP/icon.png" "$OUT/res/drawable/icon.png"
cp "$APP"/assets/* "$OUT/assets/"

"$BT/aapt2.exe" compile --dir "$OUT/res" -o "$OUT/res.zip"
"$BT/aapt2.exe" link -o "$OUT/base.apk" -I "$JAR" --manifest "$OUT/AndroidManifest.xml" -A "$OUT/assets" "$OUT/res.zip"
"$JAVA_HOME/bin/javac" -encoding UTF-8 --release 8 -nowarn -classpath "$JAR" -d "$OUT/classes" $(find "$APP/src" -name '*.java') 2>&1 | grep -v 'bootstrap\|options' || true
"$JAVA_HOME/bin/java" -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 --min-api 19 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && "$JAVA_HOME/bin/jar" uf "$OUT/base.apk" classes.dex)
"$BT/zipalign.exe" -f 4 "$OUT/base.apk" "$OUT/aligned.apk"

KS="$BUILD/vodos.keystore"   # מפתח החתימה — אותו מפתח בכל בנייה, כדי שעדכון יותקן מעל הגרסה הקודמת
[ -f "$KS" ] || "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KS" -storepass vodos123 -keypass vodos123 -alias vodos \
  -keyalg RSA -keysize 2048 -validity 20000 -dname "CN=VODOS" >/dev/null 2>&1
"$JAVA_HOME/bin/java" -jar "$BT/lib/apksigner.jar" sign --ks "$KS" --ks-pass pass:vodos123 --out "$APP/../VODOS.apk" "$OUT/aligned.apk"
echo "built $APP/../VODOS.apk"
