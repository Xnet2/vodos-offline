# עבודה מול הנגן דרך MTP (הוא מתחבר כמכשיר נייד, בלי אות כונן), בעזרת Shell.Application של Windows.
#   mtp.ps1 find                                → האם מחובר נגן עם אפליקציית VODOS, וכמה מקום פנוי בו
#   mtp.ps1 state  -Local <תיקייה>              → אילו קבצים כבר בנגן, ומה כתוב ב-state האחרון של האפליקציה
#   mtp.ps1 put    -Local <תיקייה> -List <שם>    → מעתיק לנגן קובץ אחד (הודעת מצב)
#   mtp.ps1 push   -Local <תיקייה> -List <קובץ>  → מעתיק לנגן את הקבצים שברשימה ועוד לא נמצאים בו
#   mtp.ps1 serve                               → נשאר פתוח ומקבל פקודות (שורת JSON לכל פקודה) — הפעלה של
#                                                 PowerShell לוקחת כמה שניות, אז התוכנה לא מפעילה אותו מחדש בכל פעם
param(
  [Parameter(Position = 0)][string]$Action,
  [string]$Device = '',
  [string]$Local,
  [string]$List,
  [string]$Target = 'Android\data\il.vodos.offline\files',
  [string]$Storage = '',  # האחסון שעבד בפעם הקודמת (למשל כרטיס הזיכרון) — מועדף
  [string]$Avoid = '',    # אחסון שנכשל בחיבור הזה — לא לנסות שוב
  [string]$Session = ''   # מזהה החיבור הנוכחי — בקשת עצירה מהאפליקציה היא הקובץ stop-<מזהה>.txt
)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }

function Get-Child($folder, $name) {
  try { $i = $folder.ParseName($name); if ($i) { return $i } } catch {}  # ישירות לפי שם — הרבה יותר מהיר מלעבור על כל התיקייה
  foreach ($i in $folder.Items()) { if ($i.Name -eq $name) { return $i } }
  return $null
}

function Get-Path($folder, $path) {
  foreach ($part in $path.Split('\')) {
    $child = Get-Child $folder $part
    if (-not $child) { return $null }
    $folder = $child.GetFolder
  }
  return $folder
}

# -Device <שם> מגביל למכשיר מסוים.
# כל האחסונים שיש בהם את התיקייה של האפליקציה, מהמועדף: זה שעבד בפעם הקודמת (-Storage), אחר כך זה שכבר יש בו
# סרטונים, ואחר כך הכי הרבה מקום. (בזיכרון הפנימי של אנדרואיד 11+ אסור למחשב לכתוב לתיקייה של אפליקציה,
# ומיד אחרי החיבור הרשימה בכרטיס לפעמים עוד לא נטענה — לכן לא סומכים רק על "יש בו סרטונים".)
function Storage-Names {
  $names = @()
  foreach ($dev in (New-Object -ComObject Shell.Application).Namespace(17).Items()) {
    if ($dev.IsFileSystem -or ($Device -and $dev.Name -ne $Device)) { continue }
    $names += @($dev.GetFolder.Items() | Where-Object { $_.IsFolder } | ForEach-Object { $_.Name })
  }
  return $names
}

# מיד אחרי החיבור אנדרואיד מציג קודם את הזיכרון הפנימי ורק אחר כך את הכרטיס. מחכים (עד 20 שניות) שהאחסון
# שעבד בפעם הקודמת יופיע, ושרשימת האחסונים תפסיק להשתנות — אחרת בוחרים בטעות בזיכרון הפנימי
function Wait-Storages {
  $end = (Get-Date).AddSeconds(20); $prev = $null
  while ((Get-Date) -lt $end) {
    $now = @(Storage-Names) -join '|'
    if ($now -and $now -eq $prev -and (-not $Storage -or @(Storage-Names) -contains $Storage)) { return }
    $prev = $now
    Start-Sleep -Milliseconds 1500
  }
}

# האם המכשיר עדיין מחובר — בודקים לפני כל העתקה, כי העתקה למכשיר שנותק מקפיצה חלון שגיאה של Windows
function Test-Connected { return [bool](@(Storage-Names).Count) }

function Get-Storages {
  Wait-Storages
  $sh = New-Object -ComObject Shell.Application
  $list = @()
  foreach ($dev in $sh.Namespace(17).Items()) {
    if ($dev.IsFileSystem -or ($Device -and $dev.Name -ne $Device)) { continue }  # כוננים רגילים (C: וכו') לא מעניינים
    foreach ($s in @($dev.GetFolder.Items())) {
      if (-not $s.IsFolder -or ($Avoid -and $s.Name -eq $Avoid)) { continue }
      $app = Get-Path $s.GetFolder $Target.Substring(0, $Target.LastIndexOf('\'))
      if (-not $app) { continue }
      $score = [double]$s.ExtendedProperty('System.FreeSpace')
      $files = Get-Child $app 'files'
      $hasIndex = [bool]($files -and (@($files.GetFolder.Items()) | Where-Object { $_.Name -like 'index-*.json' }))
      if ($hasIndex) { $score += 2e15 }                          # הסרטונים כבר שם — הכי חשוב
      if ($Storage -and $s.Name -eq $Storage) { $score += 1e15 }
      $list += [pscustomobject]@{ Item = $s; Score = $score; HasIndex = $hasIndex }
    }
  }
  $sorted = @($list | Sort-Object Score -Descending)
  $script:FirstHasIndex = [bool]($sorted.Count -and $sorted[0].HasIndex)
  return @($sorted | ForEach-Object { $_.Item })
}
function Get-Storage { return (Get-Storages | Select-Object -First 1) }

# התיקייה של האפליקציה באחסון המועדף — ישירות, בלי סריקה של כל האחסונים
function Get-AppFolder {
  if ($Storage) {
    foreach ($dev in (New-Object -ComObject Shell.Application).Namespace(17).Items()) {
      if ($dev.IsFileSystem) { continue }
      $s = Get-Child $dev.GetFolder $Storage
      if ($s) { $f = Get-Path $s.GetFolder $Target; if ($f) { return $f } }
    }
  }
  $s = Get-Storage
  if ($s) { return (Get-Path $s.GetFolder $Target) }
  return $null
}

# האם ביקשו בנגן לעצור את החיבור הזה: הקובץ stop-<מזהה החיבור>.txt (חיפוש ישיר לפי שם, בתיקייה טרייה)
function Test-Stop {
  if (-not $Session) { return $false }
  $folder = Get-AppFolder
  if (-not $folder) { return $false }
  $n = "stop-$Session.txt"
  $i = $folder.ParseName($n)
  return [bool]($i -and $i.Name -eq $n)
}

function Invoke-Action {
switch ($Action) {
  # בדיקה מהירה (שנייה): האם מחובר מכשיר נייד עם אחסון. החיפוש של תיקיית האפליקציה איטי — הוא נעשה רק אחרי
  # שכבר נשלחה לנגן ההודעה "מחובר"
  'find' {
    $sh = New-Object -ComObject Shell.Application
    foreach ($dev in $sh.Namespace(17).Items()) {
      if ($dev.IsFileSystem -or ($Device -and $dev.Name -ne $Device)) { continue }
      if (@($dev.GetFolder.Items() | Where-Object { $_.IsFolder }).Count) { Out-Json @{ connected = $true; device = $dev.Name }; return }
    }
    Out-Json @{ connected = $false }
  }

  # מה כבר יש בנגן, וקובץ ה-state האחרון של האפליקציה (אהבתי / נצפו / הגדרות) — מועתק ל-<Local> ונקרא משם
  'state' {
    $s = Get-Storage
    if (-not $s) { Out-Json @{ error = 'not connected' }; return }
    $folder = Get-Path $s.GetFolder $Target
    if (-not $folder) { Out-Json @{ have = @(); state = $null }; break }
    $items = @($folder.Items())
    $have = @($items | ForEach-Object { [string]$_.Name })
    $text = $null
    $states = @($items | Where-Object { $_.Name -match '^state-\d+\.json$' } | Sort-Object { [long]($_.Name -replace '\D', '') } -Descending)
    foreach ($st in $states) {
      $dest = Join-Path $Local $st.Name
      Remove-Item -LiteralPath $dest -ErrorAction SilentlyContinue
      (New-Object -ComObject Shell.Application).Namespace($Local).CopyHere($st, 4 + 16 + 1024)
      $deadline = (Get-Date).AddSeconds(20)
      while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $dest)) { Start-Sleep -Milliseconds 300 }
      Start-Sleep -Milliseconds 300
      try { $text = [IO.File]::ReadAllText($dest, [Text.Encoding]::UTF8); Remove-Item -LiteralPath $dest } catch { $text = $null }
      if ($text) { break }
    }
    Out-Json @{ have = $have; state = $text; storage = $s.Name; hasIndex = $script:FirstHasIndex; free = [double]$s.ExtendedProperty('System.FreeSpace') }
  }

  # האם ביקשו בנגן לעצור את העדכון
  'stopcheck' {
    Out-Json @{ stop = (Test-Stop) }
  }

  # קובץ אחד מהנגן למחשב (למשל applog.txt — היומן של האפליקציה), מודפס כטקסט
  'pull' {
    $s = Get-Storage
    if (-not $s) { Out-Json @{ error = 'not connected' }; return }
    $folder = Get-Path $s.GetFolder $Target
    $item = if ($folder) { $folder.ParseName($List) } else { $null }
    if (-not $item) { Out-Json @{ error = 'not found' }; return }
    $dest = Join-Path $Local $List
    Remove-Item -LiteralPath $dest -ErrorAction SilentlyContinue
    (New-Object -ComObject Shell.Application).Namespace($Local).CopyHere($item, 4 + 16 + 1024)
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $dest)) { Start-Sleep -Milliseconds 300 }
    Start-Sleep -Milliseconds 300
    Out-Json @{ text = [IO.File]::ReadAllText($dest, [Text.Encoding]::UTF8) }
  }

  # קובץ אחד לנגן (הודעת מצב status-*.json) — בלי רשימת התקדמות
  # בודק גם שהקובץ באמת הגיע — ואם לא, מנסה באחסון הבא. מחזיר את האחסון שעבד
  'put' {
    # קודם ישר לאחסון שעבד בפעם הקודמת (מהיר); רק אם אין — סריקה מלאה של כל האחסונים
    $all = @()
    if ($Storage -and $Storage -ne $Avoid) {
      Wait-Storages
      $sh = New-Object -ComObject Shell.Application
      foreach ($dev in $sh.Namespace(17).Items()) {
        if ($dev.IsFileSystem) { continue }
        $s = Get-Child $dev.GetFolder $Storage
        if ($s) { $all = @($s); break }
      }
    }
    if (-not $all.Count) { $all = Get-Storages }
    if (-not $all.Count) { Out-Json @{ error = 'not connected' }; return }
    $path = Join-Path $Local $List
    foreach ($s in $all) {
      $folder = Get-Path $s.GetFolder $Target
      if (-not $folder) { continue }
      Out-Json @{ trying = $s.Name }
      if (-not (Test-Connected)) { Out-Json @{ error = 'disconnected' }; return }
      $folder.CopyHere($path, 4 + 16 + 1024)
      $deadline = (Get-Date).AddSeconds(12)
      while ((Get-Date) -lt $deadline -and -not $folder.ParseName($List)) { Start-Sleep -Milliseconds 300 }
      if ($folder.ParseName($List)) { Out-Json @{ ok = $true; storage = $s.Name }; return }
    }
    # האחסון המועדף לא עבד — סריקה מלאה של השאר
    if ($Storage) {
      foreach ($s in (Get-Storages | Where-Object { $_.Name -ne $Storage })) {
        $folder = Get-Path $s.GetFolder $Target
        if (-not $folder) { continue }
        Out-Json @{ trying = $s.Name }
        if (-not (Test-Connected)) { Out-Json @{ error = 'disconnected' }; return }
        $folder.CopyHere($path, 4 + 16 + 1024)
        $deadline = (Get-Date).AddSeconds(12)
        while ((Get-Date) -lt $deadline -and -not $folder.ParseName($List)) { Start-Sleep -Milliseconds 300 }
        if ($folder.ParseName($List)) { Out-Json @{ ok = $true; storage = $s.Name }; return }
      }
    }
    Out-Json @{ ok = $false }
  }

  'push' {
    $s = Get-Storage
    if (-not $s) { Out-Json @{ error = 'not connected' }; return }
    $folder = $s.GetFolder
    foreach ($part in $Target.Split('\')) {  # תיקיית האפליקציה כבר קיימת; כאן נוצרת רק files אם חסרה
      $child = Get-Child $folder $part
      if (-not $child) { $folder.NewFolder($part); Start-Sleep -Milliseconds 700; $child = Get-Child $folder $part }
      if (-not $child) { Out-Json @{ error = "cannot create $part" }; return }
      $folder = $child.GetFolder
    }
    $have = @{}
    foreach ($i in $folder.Items()) { $have[$i.Name] = $true }
    # [string] — בלי זה כל שורה נושאת מאפיינים של PowerShell, וה-JSON מתנפח למגה-בייטים
    $names = Get-Content -LiteralPath $List -Encoding UTF8 | ForEach-Object { [string]$_ } | Where-Object { $_ -and -not $have.ContainsKey($_) }
    $names = @($names | Where-Object { Test-Path -LiteralPath (Join-Path $Local $_) })
    Out-Json @{ todo = $names.Count; existing = $have.Count }

    function Copy-One($n) {
      if (-not (Test-Connected)) { return $false }
      $path = Join-Path $Local $n
      $size = (Get-Item -LiteralPath $path).Length
      $folder.CopyHere($path, 4 + 16 + 1024)  # בלי חלון התקדמות, "כן לכל", בלי חלונות שגיאה
      # ההעתקה רצה ברקע — מחכים שהקובץ יופיע בנגן (אחרת סגירת התהליך עוצרת אותה)
      $deadline = (Get-Date).AddSeconds(30 + $size / 1MB * 3); $nextStop = (Get-Date).AddSeconds(2)
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 400
        $it = $folder.ParseName($n)
        if (-not $it) { $it = Get-Child $folder $n }
        if ($it -and [double]$it.ExtendedProperty('System.Size') -ge $size) { return $true }
        # גם באמצע קובץ גדול — כל 2 שניות בודקים אם ביקשו לעצור, כדי לא להתחיל את הבא
        if ((Get-Date) -gt $nextStop) { $nextStop = (Get-Date).AddSeconds(2); if (Test-Stop) { $script:StopHit = $true; return $false } }
      }
      return $false
    }

    # קודם רשימת הקבצים שעומדים להגיע (sync-*.json) — ממנה האפליקציה בנגן מציגה את ההתקדמות
    if ($names.Count) {
      $sync = 'sync-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '.json'
      $json = @{ total = $names.Count; files = $names; session = $Session } | ConvertTo-Json -Compress
      [IO.File]::WriteAllText((Join-Path $Local $sync), $json, (New-Object Text.UTF8Encoding $false))
      [void](Copy-One $sync)
      Remove-Item -LiteralPath (Join-Path $Local $sync) -ErrorAction SilentlyContinue
    }
    $done = 0; $script:StopHit = $false
    foreach ($n in $names) {
      if (-not (Test-Connected)) { Out-Json @{ error = 'disconnected'; copied = $done }; return }
      # לפני כל קובץ: אם ביקשו בנגן לעצור — מפסיקים (מה שכבר הועתק נשאר)
      if ($script:StopHit -or (Test-Stop)) { Out-Json @{ stopped = $true; copied = $done }; return }
      $ok = Copy-One $n
      $done++
      Out-Json @{ file = $n; ok = $ok; done = $done }
    }
    Out-Json @{ finished = $true; copied = $done }
  }


  default { Out-Json @{ error = "unknown action: $Action" } }
}
}

if ($Action -eq 'serve') {
  # כל שורה: {"id":1,"action":"put","local":"…","list":"…","storage":"…","avoid":"…"}; בסוף כל פקודה: {"end":1}
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    if (-not $line.Trim()) { continue }
    $req = $line | ConvertFrom-Json
    $Action = [string]$req.action; $Local = [string]$req.local; $List = [string]$req.list
    $Storage = [string]$req.storage; $Avoid = [string]$req.avoid; $Session = [string]$req.session
    try { Invoke-Action } catch { Out-Json @{ error = $_.Exception.Message } }
    Out-Json @{ end = $req.id }
  }
} else {
  Invoke-Action
}
