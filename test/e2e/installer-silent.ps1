# Silent install → reinstall → uninstall of the real NSIS installer, per-user, into a custom
# folder, checking files, registry, shortcuts and that %APPDATA%\AniVerse (library, settings,
# accounts) is never touched.  Usage: pwsh test/e2e/installer-silent.ps1 [installer.exe]
param([string]$Installer = (Resolve-Path "$PSScriptRoot\..\..\release\AniVerse-Setup-*.exe" | Select-Object -Last 1).Path)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot\..\.."
$target = Join-Path $root 'test\cache\install-silent\AniVerse'
$data = Join-Path $env:APPDATA 'AniVerse'
$startLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'AniVerse.lnk'
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AniVerse.lnk'
$results = [ordered]@{}

function Fingerprint() {
  if (-not (Test-Path $data)) { return 'no data folder' }
  $files = Get-ChildItem $data -File | Where-Object { $_.Name -in 'aniverse.db', 'profile.id' }
  ($files | ForEach-Object { "$($_.Name):$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.Substring(0, 12))" }) -join ' '
}
function UninstallEntry() {
  # "Apps & features" entry plus electron-builder's own install record (Software\<app id>\InstallLocation)
  $u = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } |
    Where-Object { $_.DisplayName -like 'AniVerse*' } | Select-Object -First 1
  if (-not $u) { return $null }
  $loc = (Get-ChildItem 'HKCU:\Software' | ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |
    Where-Object { $_.InstallLocation -like '*AniVerse*' } | Select-Object -First 1).InstallLocation
  [pscustomobject]@{ DisplayName = $u.DisplayName; InstallLocation = $loc }
}
function Run($argsList) {
  $p = Start-Process -FilePath $Installer -ArgumentList $argsList -PassThru -Wait
  return $p.ExitCode
}

Remove-Item (Split-Path $target) -Recurse -Force -ErrorAction SilentlyContinue
$before = Fingerprint
$results.installer = Split-Path $Installer -Leaf
$results.sizeMB = [math]::Round((Get-Item $Installer).Length / 1MB, 1)

# 1. fresh install into E:\...\AniVerse without a desktop shortcut, no admin
$results.install = Run @('/S', '--no-desktop-shortcut', "/D=$target")
$entry = UninstallEntry
$results.installed = [ordered]@{
  exe = Test-Path (Join-Path $target 'AniVerse.exe')
  uninstaller = Test-Path (Join-Path $target 'Uninstall AniVerse.exe')
  appsAndFeatures = $entry.DisplayName
  registryLocation = $entry.InstallLocation
  startMenuLink = Test-Path $startLink
  desktopLink = Test-Path $desktopLink
  files = (Get-ChildItem $target -Recurse -File | Measure-Object).Count
}

# 2. reinstall / upgrade over it
$results.reinstall = Run @('/S', '--no-desktop-shortcut', "/D=$target")
$results.afterReinstall = [ordered]@{ exe = Test-Path (Join-Path $target 'AniVerse.exe'); registryLocation = (UninstallEntry).InstallLocation; dataUnchanged = ((Fingerprint) -eq $before) }

# 3. uninstall
$un = Join-Path $target 'Uninstall AniVerse.exe'
$p = Start-Process -FilePath $un -ArgumentList '/S' -PassThru -Wait
Start-Sleep -Seconds 3 # the uninstaller copies itself to %TEMP% and finishes there
$results.uninstall = $p.ExitCode
$results.afterUninstall = [ordered]@{
  folderGone = -not (Test-Path (Join-Path $target 'AniVerse.exe'))
  registryGone = -not (UninstallEntry)
  startMenuLinkGone = -not (Test-Path $startLink)
  dataKept = Test-Path (Join-Path $data 'aniverse.db')
  dataUnchanged = ((Fingerprint) -eq $before)
}
$results | ConvertTo-Json -Depth 4
