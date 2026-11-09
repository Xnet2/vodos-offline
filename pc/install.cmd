@echo off
chcp 65001 >nul
rem מתקין את "VODOS לנגן": מעתיק את התוכנה ל-%LOCALAPPDATA%\VODOS-M36\app
rem ומוסיף אותה להפעלה האוטומטית של Windows (רצה ברקע, בלי חלון).
set "DEST=%LOCALAPPDATA%\VODOS-M36\app"
rem עדכון: עוצרים את הגרסה שכבר רצה ברקע, כדי שלא ירוצו שתיים
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*VODOS*\app\sync.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
mkdir "%DEST%" 2>nul
copy /y "%~dp0sync.mjs" "%DEST%\" >nul
copy /y "%~dp0mtp.ps1" "%DEST%\" >nul
for /f "delims=" %%n in ('where node 2^>nul') do set "NODE=%%n" & goto found
rem אין Node.js — מתקינים אותו (התוכנה כתובה ב-Node)
echo מתקין Node.js...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" echo לא הצלחתי להתקין את Node.js. התקינו אותו מ-nodejs.org והריצו שוב. & pause & exit /b 1
:found
rem בקובץ ה-VBS רק נתיבים קצרים (באנגלית) — הוא לא קורא עברית
for %%i in ("%DEST%\sync.mjs") do set "SSYNC=%%~si"
for %%i in ("%NODE%") do set "SNODE=%%~si"
set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\VODOS-M36.vbs"
> "%VBS%" echo CreateObject("WScript.Shell").Run """%SNODE%"" ""%SSYNC%""", 0, False
wscript "%VBS%"
echo הותקן. התוכנה רצה עכשיו ברקע, ותופעל אוטומטית בכל הפעלה של המחשב.
echo יומן: %LOCALAPPDATA%\VODOS-M36\log.txt
