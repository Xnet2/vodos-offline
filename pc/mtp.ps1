# עבודה מול הנגן דרך MTP (הוא מתחבר כמכשיר נייד, בלי אות כונן), בעזרת Shell.Application של Windows.
#   mtp.ps1 find                                → האם מחובר נגן עם אפליקציית VODOS, וכמה מקום פנוי בו
#   mtp.ps1 push   -Local <תיקייה> -List <קובץ>  → מעתיק לנגן את הקבצים שברשימה ועוד לא נמצאים בו
#   mtp.ps1 notify -Text <הודעה>                 → הודעה קטנה בפינת המסך
param(
  [Parameter(Position = 0)][string]$Action,
  [string]$Device = '',
  [string]$Local,
  [string]$List,
  [string]$Text,
  [string]$Target = 'Android\data\il.vodos.offline\files'
)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }

function Get-Child($folder, $name) {
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

# מחפש בכל המכשירים הניידים המחוברים (נגן, טלפון…) אחסון שיש בו את התיקייה של אפליקציית VODOS
# (האפליקציה יוצרת אותה בפתיחה הראשונה). אם יש כמה — זה שכבר יש בו סרטונים, ואחרת זה עם הכי הרבה מקום פנוי.
# -Device <שם> מגביל למכשיר מסוים.
function Get-Storage {
  $sh = New-Object -ComObject Shell.Application
  $best = $null; $bestScore = -1
  foreach ($dev in $sh.Namespace(17).Items()) {
    if ($dev.IsFileSystem -or ($Device -and $dev.Name -ne $Device)) { continue }  # כוננים רגילים (C: וכו') לא מעניינים
    foreach ($s in @($dev.GetFolder.Items())) {
      if (-not $s.IsFolder) { continue }
      $app = Get-Path $s.GetFolder $Target.Substring(0, $Target.LastIndexOf('\'))
      if (-not $app) { continue }
      $score = [double]$s.ExtendedProperty('System.FreeSpace')
      $files = Get-Child $app 'files'
      if ($files -and (@($files.GetFolder.Items()) | Where-Object { $_.Name -like 'index-*.json' })) { $score += 1e15 }
      if ($score -gt $bestScore) { $best = $s; $bestScore = $score }
    }
  }
  return $best
}

switch ($Action) {
  'find' {
    $s = Get-Storage
    if (-not $s) { Out-Json @{ connected = $false }; break }
    $free = $s.ExtendedProperty('System.FreeSpace')
    Out-Json @{ connected = $true; storage = $s.Name; free = [double]$free }
  }

  'push' {
    $s = Get-Storage
    if (-not $s) { Out-Json @{ error = 'not connected' }; exit 1 }
    $folder = $s.GetFolder
    foreach ($part in $Target.Split('\')) {  # תיקיית האפליקציה כבר קיימת; כאן נוצרת רק files אם חסרה
      $child = Get-Child $folder $part
      if (-not $child) { $folder.NewFolder($part); Start-Sleep -Milliseconds 700; $child = Get-Child $folder $part }
      if (-not $child) { Out-Json @{ error = "cannot create $part" }; exit 1 }
      $folder = $child.GetFolder
    }
    $have = @{}
    foreach ($i in $folder.Items()) { $have[$i.Name] = $true }
    # [string] — בלי זה כל שורה נושאת מאפיינים של PowerShell, וה-JSON מתנפח למגה-בייטים
    $names = Get-Content -LiteralPath $List -Encoding UTF8 | ForEach-Object { [string]$_ } | Where-Object { $_ -and -not $have.ContainsKey($_) }
    Out-Json @{ todo = @($names).Count; existing = $have.Count }
    $done = 0
    foreach ($n in $names) {
      $path = Join-Path $Local $n
      if (-not (Test-Path -LiteralPath $path)) { continue }
      $size = (Get-Item -LiteralPath $path).Length
      $folder.CopyHere($path, 4 + 16 + 1024)  # בלי חלון התקדמות, "כן לכל", בלי חלונות שגיאה
      # ההעתקה רצה ברקע — מחכים שהקובץ יופיע בנגן (אחרת סגירת התהליך עוצרת אותה)
      $deadline = (Get-Date).AddSeconds(30 + $size / 1MB * 3)
      $ok = $false
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 400
        $it = $folder.ParseName($n)
        if (-not $it) { $it = Get-Child $folder $n }
        if ($it -and [double]$it.ExtendedProperty('System.Size') -ge $size) { $ok = $true; break }
      }
      $done++
      Out-Json @{ file = $n; ok = $ok; done = $done }
    }
    Out-Json @{ finished = $true; copied = $done }
  }

  'notify' {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon = [System.Drawing.SystemIcons]::Information
    $n.BalloonTipTitle = 'VODOS לנגן'
    $n.BalloonTipText = $Text
    $n.Visible = $true
    $n.ShowBalloonTip(6000)
    Start-Sleep -Seconds 7
    $n.Dispose()
  }

  default { Write-Error "unknown action: $Action"; exit 2 }
}
