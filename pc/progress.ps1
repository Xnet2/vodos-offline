# חלון ההתקדמות שקופץ בפינת המסך כשמחברים את הנגן.
# sync.mjs כותב את המצב לקובץ progress.json, והחלון קורא אותו כל רבע שנייה:
#   { "phase": "check" | "download" | "copy" | "done" | "error", "text": "...", "done": 12, "total": 191 }
# בסוף (done / error) החלון נסגר לבד אחרי 15 שניות.
param([Parameter(Mandatory)][string]$State)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'VODOS לנגן'
$form.RightToLeft = 'Yes'; $form.RightToLeftLayout = $true
$form.FormBorderStyle = 'FixedToolWindow'
$form.ClientSize = New-Object System.Drawing.Size(380, 104)
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.BackColor = [System.Drawing.Color]::White
$form.StartPosition = 'Manual'
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($area.Right - $form.Width - 16), ($area.Bottom - $form.Height - 16))

$iconFile = Join-Path $PSScriptRoot 'icon.png'
if (Test-Path $iconFile) {
  $bmp = New-Object System.Drawing.Bitmap $iconFile
  $form.Icon = [System.Drawing.Icon]::FromHandle((New-Object System.Drawing.Bitmap $bmp, 32, 32).GetHicon())
  $pic = New-Object System.Windows.Forms.PictureBox
  $pic.Image = $bmp; $pic.SizeMode = 'Zoom'
  $pic.SetBounds(16, 16, 44, 44)
  $form.Controls.Add($pic)
}

$title = New-Object System.Windows.Forms.Label
$title.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
$title.SetBounds(72, 12, 296, 24)
$title.Text = 'הנגן חובר'
$form.Controls.Add($title)

$label = New-Object System.Windows.Forms.Label
$label.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
$label.ForeColor = [System.Drawing.Color]::FromArgb(90, 90, 100)
$label.SetBounds(72, 38, 296, 22)
$label.Text = 'בודק סרטונים חדשים…'
$form.Controls.Add($label)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.SetBounds(16, 72, 352, 14)
$bar.Style = 'Marquee'; $bar.MarqueeAnimationSpeed = 30
$form.Controls.Add($bar)

$script:closeAt = $null
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
  try { $s = [IO.File]::ReadAllText($State, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { return }
  if ($s.text) { $label.Text = $s.text }
  switch ($s.phase) {
    'copy' {
      $title.Text = 'מעתיק סרטונים לנגן'
      if ($s.total -gt 0) {
        $bar.Style = 'Continuous'; $bar.Maximum = [int]$s.total; $bar.Value = [Math]::Min([int]$s.done, [int]$s.total)
      }
      $script:closeAt = $null
    }
    { $_ -in 'check', 'download' } {
      $title.Text = 'מכין סרטונים חדשים'
      $bar.Style = 'Marquee'; $script:closeAt = $null
    }
    'done' {
      $title.Text = 'הנגן מעודכן ✓'
      $bar.Style = 'Continuous'; $bar.Maximum = 1; $bar.Value = 1
      if (-not $script:closeAt) { $script:closeAt = (Get-Date).AddSeconds(15) }
    }
    'error' {
      $title.Text = 'ההעתקה לא הסתיימה'
      $bar.Style = 'Continuous'; $bar.Value = 0
      if (-not $script:closeAt) { $script:closeAt = (Get-Date).AddSeconds(15) }
    }
  }
  if ($script:closeAt -and (Get-Date) -gt $script:closeAt) { $form.Close() }
})
$form.Add_Shown({ $timer.Start(); $form.Activate() })
[System.Windows.Forms.Application]::Run($form)
