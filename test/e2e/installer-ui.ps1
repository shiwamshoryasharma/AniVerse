# Drives the real NSIS installer UI page by page (window kept off-screen), takes a screenshot of
# each page into test/artifacts/installer-*.png and checks the behaviour behind each control.
# Usage: pwsh test/e2e/installer-ui.ps1 [installer.exe]
param([string]$Installer = (Resolve-Path "$PSScriptRoot\..\..\release\AniVerse-Setup-*.exe" | Select-Object -Last 1).Path)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  // Enumeration stays in C#: PowerShell script blocks called back from native code upset the host.
  public static IntPtr[] Children(IntPtr parent) {
    var list = new System.Collections.Generic.List<IntPtr>();
    EnumChildWindows(parent, (h, l) => { list.Add(h); return true; }, IntPtr.Zero);
    return list.ToArray();
  }
  public static IntPtr[] TopWindows(int[] pids) {
    var list = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (Array.IndexOf(pids, (int)p) >= 0 && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list.ToArray();
  }
}
"@
[void][W]::SetProcessDpiAwarenessContext([IntPtr]-4)
$root = Resolve-Path "$PSScriptRoot\..\.."
$art = Join-Path $root 'test\artifacts'
$installRoot = Join-Path $root 'test\cache\install-ui'
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AniVerse.lnk'
$startLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'AniVerse.lnk'
$out = [ordered]@{}

function ClassOf($h) { $s = [Text.StringBuilder]::new(128); [void][W]::GetClassNameW($h, $s, 128); $s.ToString() }
# GetWindowText can't read an edit box in another process; WM_GETTEXT can.
function Text($h) {
  $s = [Text.StringBuilder]::new(1024)
  if ((ClassOf $h) -eq 'Edit') { [void][W]::SendMessageW($h, 0x000D, [IntPtr]1024, $s) } else { [void][W]::GetWindowTextW($h, $s, 1024) }
  $s.ToString()
}
function Children($h) { [W]::Children($h) }
function TopWindows([int[]]$pids) { [W]::TopWindows($pids) }
function Wait($what, [scriptblock]$test, $ms = 20000) {
  $end = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $end) { $r = & $test; if ($r) { return $r }; Start-Sleep -Milliseconds 150 }
  throw "timed out waiting for $what"
}
function OffScreen($h) { [void][W]::SetWindowPos($h, [IntPtr]::Zero, -4000, -4000, 0, 0, 0x15) }
function Shot($h, $name) {
  $r = New-Object W+RECT; [void][W]::GetWindowRect($h, [ref]$r)
  $bmp = [Drawing.Bitmap]::new($r.R - $r.L, $r.B - $r.T); $g = [Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc(); [void][W]::PrintWindow($h, $hdc, 2); $g.ReleaseHdc($hdc); $g.Dispose()
  $bmp.Save((Join-Path $art "installer-$name.png")); $bmp.Dispose()
}
# Presses a dialog button by posting the dialog's own WM_COMMAND (BN_CLICKED). Unlike BM_CLICK
# this works while the window is inactive (e.g. after a message box), and posting keeps a
# click that opens a modal message box from blocking the test.
function Press($window, $id) { [void][W]::PostMessageW($window, 0x0111, [IntPtr]$id, [W]::GetDlgItem($window, $id)) }
function Find($h, [scriptblock]$match) { Children $h | Where-Object { & $match $_ } | Select-Object -First 1 }
function ByText($h, $pattern) { Find $h { param($c) (Text $c) -match $pattern } }

# Only one installer may run at a time: close leftovers from an interrupted run.
Get-Process | Where-Object { $_.ProcessName -like 'AniVerse-Setup*' } | Stop-Process -Force
Start-Sleep -Milliseconds 500
Remove-Item $installRoot -Recurse -Force -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $Installer -PassThru
$pids = @($proc.Id)
$main = Wait 'installer window' { TopWindows $pids | Where-Object { (Text $_) -match 'AniVerse' } | Select-Object -First 1 }
OffScreen $main
Start-Sleep -Milliseconds 900
$out.title = Text $main
Shot $main '1-welcome'
# Top-level controls of the installer window (id, class, visible, position) for layout checks.
$out.chrome = @(Children $main | Where-Object { [W]::GetDlgCtrlID($_) -lt 1100 } | ForEach-Object {
  $r = New-Object W+RECT; [void][W]::GetWindowRect($_, [ref]$r)
  "$([W]::GetDlgCtrlID($_)) $(ClassOf $_) visible=$([W]::IsWindowVisible($_)) y=$($r.T - (-4000)) h=$($r.B - $r.T) '$(Text $_)'"
})
$out.welcome = (ByText $main '^Welcome to AniVerse') -ne $null
$next = [W]::GetDlgItem($main, 1)

# Folder page
Press $main 1
Start-Sleep -Milliseconds 1200
$dir = Find $main { param($c) (ClassOf $c) -eq 'Edit' }
if (-not $dir) {
  Shot $main 'debug-after-next'
  $out.afterNext = @(Children $main | ForEach-Object { "$([W]::GetDlgCtrlID($_)) $(ClassOf $_) visible=$([W]::IsWindowVisible($_)) '$(Text $_)'" })
  $out | ConvertTo-Json -Depth 4
  throw 'folder page not found'
}
Start-Sleep -Milliseconds 400
$out.defaultFolder = Text $dir
Shot $main '2-folder'

# A folder that needs administrator rights is refused with an explanation.
[void][W]::SendMessageW($dir, 0x000C, [IntPtr]::Zero, 'C:\Program Files\AniVerse')
Press $main 1
try {
  $msg = Wait 'permission message' { TopWindows $pids | Where-Object { $_ -ne $main -and (ClassOf $_) -eq '#32770' } | Select-Object -First 1 } 8000
} catch {
  Shot $main 'debug-permission'
  $out.windows = @(TopWindows $pids | ForEach-Object { "$(ClassOf $_) '$(Text $_)'" })
  $out.page = @(Children $main | Where-Object { [W]::IsWindowVisible($_) } | ForEach-Object { "$([W]::GetDlgCtrlID($_)) $(ClassOf $_) '$(Text $_)'" })
  $out | ConvertTo-Json -Depth 4
  throw
}
$out.permissionMessage = ((Children $msg | Where-Object { (ClassOf $_) -eq 'Static' } | ForEach-Object { Text $_ }) -join ' ').Trim()
Shot $msg '3-permission'
[void][W]::PostMessageW($msg, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) # WM_CLOSE = OK on a message box
Wait 'message box closed' { -not (TopWindows $pids | Where-Object { $_ -eq $msg }) } | Out-Null
Start-Sleep -Milliseconds 400

# Any other drive: E:\…\install-ui (AniVerse is appended)
[void][W]::SendMessageW($dir, 0x000C, [IntPtr]::Zero, $installRoot)
Press $main 1
try {
  $desktopBox = Wait 'shortcuts page' { ByText $main '^Create a desktop shortcut' } 15000
} catch {
  Shot $main 'debug-shortcuts'
  $out.windows = @(TopWindows $pids | ForEach-Object { "$(ClassOf $_) '$(Text $_)'" })
  $out.page = @(Children $main | Where-Object { [W]::IsWindowVisible($_) } | ForEach-Object { "$([W]::GetDlgCtrlID($_)) $(ClassOf $_) '$(Text $_)'" })
  $out | ConvertTo-Json -Depth 4
  throw
}
$startBox = ByText $main '^Create a Start Menu shortcut'
Start-Sleep -Milliseconds 400
$out.shortcutsPage = [ordered]@{
  folder = Text (ByText $main 'install-ui')
  space = Text (ByText $main '^Space required')
  desktopChecked = [int][W]::SendMessageW($desktopBox, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero)
  startMenuChecked = [int][W]::SendMessageW($startBox, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero)
  nextButton = Text $next
}
Shot $main '4-shortcuts'
[void][W]::SendMessageW($desktopBox, 0x00F1, [IntPtr]::Zero, [IntPtr]::Zero) # BM_SETCHECK unchecked

# Install: sample the real progress bar while files are extracted
Press $main 1
try {
  $bar = Wait 'progress bar' { Find $main { param($c) (ClassOf $c) -eq 'msctls_progress32' } } 15000
} catch {
  Shot $main 'debug-progress'
  $out.windows = @(TopWindows $pids | ForEach-Object { "$(ClassOf $_) '$(Text $_)'" + ' :: ' + ((Children $_ | Where-Object { (ClassOf $_) -eq 'Static' } | ForEach-Object { Text $_ }) -join ' / ') })
  $out.page = @(Children $main | Where-Object { [W]::IsWindowVisible($_) } | ForEach-Object { "$([W]::GetDlgCtrlID($_)) $(ClassOf $_) '$(Text $_)'" })
  $out | ConvertTo-Json -Depth 4
  throw
}
$samples = @(); $shot = $false
$end = (Get-Date).AddMinutes(5)
while ((Get-Date) -lt $end) {
  $pos = [int][W]::SendMessageW($bar, 0x0408, [IntPtr]::Zero, [IntPtr]::Zero) # PBM_GETPOS
  if ($samples.Count -eq 0 -or $samples[-1] -ne $pos) { $samples += $pos }
  if (-not $shot -and $pos -gt 300 -and $pos -lt 25000) { Shot $main '5-progress'; $shot = $true }
  if (ByText $main '^Launch AniVerse now') { break }
  Start-Sleep -Milliseconds 100
}
$out.progressSamples = $samples.Count
$out.progressRange = "$($samples[0]) .. $($samples[-1])"

# Finish page
$run = Wait 'finish page' { ByText $main '^Launch AniVerse now' }
Start-Sleep -Milliseconds 500
$out.launchChecked = [int][W]::SendMessageW($run, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero)
Shot $main '6-finish'
[void][W]::SendMessageW($run, 0x00F1, [IntPtr]::Zero, [IntPtr]::Zero) # don't launch during the test
Press $main 1
Wait 'installer exit' { $proc.HasExited } | Out-Null

$target = Join-Path $installRoot 'AniVerse'
$out.installed = [ordered]@{ exe = Test-Path (Join-Path $target 'AniVerse.exe'); desktopLink = Test-Path $desktopLink; startMenuLink = Test-Path $startLink }

# Uninstaller UI (it relaunches itself from %TEMP%, so look for its window by title)
$un = Start-Process -FilePath (Join-Path $target 'Uninstall AniVerse.exe') -PassThru
$unWin = Wait 'uninstaller window' {
  $all = Get-Process | Where-Object { $_.MainWindowTitle -match 'AniVerse' -and $_.Id -ne $PID } | ForEach-Object { $_.Id }
  TopWindows $all | Where-Object { (Text $_) -match 'Uninstall' } | Select-Object -First 1
}
OffScreen $unWin
Start-Sleep -Milliseconds 700
Shot $unWin '7-uninstall'
$unPid = 0; [void][W]::GetWindowThreadProcessId($unWin, [ref]$unPid)
Press $unWin 1
Wait 'uninstall finish' { ByText $unWin 'has been uninstalled|Completing|Finish' } 60000 | Out-Null
Start-Sleep -Milliseconds 500
Shot $unWin '8-uninstalled'
Press $unWin 1
Wait 'uninstaller exit' { -not (Get-Process -Id $unPid -ErrorAction SilentlyContinue) } | Out-Null
Start-Sleep -Seconds 2
$out.uninstalled = [ordered]@{ exeGone = -not (Test-Path (Join-Path $target 'AniVerse.exe')); startMenuLinkGone = -not (Test-Path $startLink); dataKept = Test-Path (Join-Path $env:APPDATA 'AniVerse\aniverse.db') }
$out | ConvertTo-Json -Depth 4
