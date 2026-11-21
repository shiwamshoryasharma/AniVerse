# Drives the splash and welcome screens in Windows Sandbox and cancels setup.
param([string]$Installer, [string]$GuestOutput)
$ErrorActionPreference = 'Stop'
if (!$GuestOutput) {
    $installerPath = (Resolve-Path -LiteralPath $Installer).Path
    if (Get-Process -Name 'WindowsSandbox','WindowsSandboxClient','WindowsSandboxRemoteSession' -ErrorAction SilentlyContinue) { throw 'A Windows Sandbox session is already running.' }
    $run = Join-Path (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path ('cache\aniverse2\branding-sandbox-' + [datetime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))
    $inputFolder = Join-Path $run 'input'
    $outputFolder = Join-Path $run 'output'
    New-Item -ItemType Directory -Path $inputFolder,$outputFolder | Out-Null
    Copy-Item -LiteralPath $installerPath -Destination (Join-Path $inputFolder 'installer.exe')
    Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $inputFolder 'validate.ps1')
    $inputXml = [Security.SecurityElement]::Escape($inputFolder)
    $outputXml = [Security.SecurityElement]::Escape($outputFolder)
    $config = Join-Path $run 'installer-branding.wsb'
    @"
<Configuration>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <MappedFolders>
    <MappedFolder><HostFolder>$inputXml</HostFolder><SandboxFolder>C:\BrandingInput</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$outputXml</HostFolder><SandboxFolder>C:\BrandingOutput</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\BrandingInput\validate.ps1 -Installer C:\BrandingInput\installer.exe -GuestOutput C:\BrandingOutput</Command>
  </LogonCommand>
</Configuration>
"@ | Set-Content -LiteralPath $config
    Write-Output $run
    Start-Process -FilePath "$env:WINDIR\System32\WindowsSandbox.exe" -ArgumentList ('"{0}"' -f $config)
    return
}
if ($env:USERNAME -ne 'WDAGUtilityAccount' -or $GuestOutput -ne 'C:\BrandingOutput') {
    throw 'The installer may only run in disposable Windows Sandbox.'
}
$out = [ordered]@{passed = $false}
try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BrandingWindow {
    private delegate bool WindowCallback(IntPtr handle, IntPtr context);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr handle, WindowCallback callback, IntPtr context);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr handle, System.Text.StringBuilder text, int length);
    public static bool HasVisibleCaption(IntPtr handle, string target) {
        var buffer = new System.Text.StringBuilder(2048);
        var found = false;
        EnumChildWindows(handle, (child, context) => {
            if (IsWindowVisible(child) && GetWindowTextW(child, buffer, buffer.Capacity) > 0 &&
                buffer.ToString().Trim() == target) { found = true; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect r);
    [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
}
"@
    function Shot($handle, $name) {
        $rect = New-Object BrandingWindow+Rect
        if (![BrandingWindow]::GetWindowRect($handle, [ref]$rect)) { throw "Window disappeared before $name capture" }
        $image = [Drawing.Bitmap]::new($rect.R - $rect.L, $rect.B - $rect.T)
        $graphics = [Drawing.Graphics]::FromImage($image)
        try {
            $graphics.CopyFromScreen($rect.L, $rect.T, 0, 0, $image.Size)
            $image.Save((Join-Path $GuestOutput "$name.png"), [Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $image.Dispose()
        }
    }
    function NamedElement($element, $name, $processId = 0) {
        $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, $name)
        if ($processId) {
            $owner = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty, $processId)
            $condition = New-Object Windows.Automation.AndCondition($condition, $owner)
        }
        $element.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
    }

    $proc = Start-Process -FilePath $Installer -PassThru
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $out.welcomeVisibleBeforeSplash = $false
    try {
    while ($clock.ElapsedMilliseconds -lt 20000) {
        $splash = Get-Process -Name AniVerse2SetupSplash -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
        if ($splash) { break }
        $proc.Refresh()
        if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
            if ([BrandingWindow]::HasVisibleCaption($proc.MainWindowHandle, 'Welcome to AniVerse2')) { $out.welcomeVisibleBeforeSplash = $true }
        }
        Start-Sleep -Milliseconds 30
    }
    if (!$splash) { throw 'The installer splash never appeared.' }
    $out.splashAppearedMs = $clock.ElapsedMilliseconds
    $handle = $splash.MainWindowHandle
    $out.splashHandle = $handle.ToInt64()
    $out.splashTitle = $splash.MainWindowTitle
    $proc.Refresh()
    $out.welcomeHiddenDuringSplash = $proc.MainWindowHandle -eq [IntPtr]::Zero
    Shot $handle 'splash-1'
    $skip = $null
    for ($retry = 0; $retry -lt 10 -and !$skip; ++$retry) {
        try {
            $element = [Windows.Automation.AutomationElement]::FromHandle($handle)
            $skip = NamedElement $element 'Skip intro'
        } catch {
            $out.lastUiaError = $_.Exception.Message
        }
        if (!$skip) { Start-Sleep -Milliseconds 65 }
    }
    $out.skipFound = $null -ne $skip
    Start-Sleep -Milliseconds 850
    Shot $handle 'splash-2'
    $out.splashFrameChanged = (Get-FileHash (Join-Path $GuestOutput 'splash-1.png')).Hash -ne
        (Get-FileHash (Join-Path $GuestOutput 'splash-2.png')).Hash
    if (!$skip) { throw 'Skip intro was not accessible.' }
    $skip.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    $out.skipInvoked = $true
    } catch {
        $out.splashError = $_.Exception.Message
    }
    $deadlineMs = $clock.ElapsedMilliseconds + 10000
    while ($clock.ElapsedMilliseconds -lt $deadlineMs) {
        $proc.Refresh()
        $welcomeHandle = $proc.MainWindowHandle
        if ($welcomeHandle -ne [IntPtr]::Zero) {

            if ([BrandingWindow]::HasVisibleCaption($welcomeHandle, 'Welcome to AniVerse2')) { break }
        }
        Start-Sleep -Milliseconds 50
    }
    if ($welcomeHandle -eq [IntPtr]::Zero -or ![BrandingWindow]::HasVisibleCaption($welcomeHandle, 'Welcome to AniVerse2')) { throw 'The branded welcome page did not appear.' }
    $out.welcomeMs = $clock.ElapsedMilliseconds
    $out.welcomeTitle = $proc.MainWindowTitle
    $out.welcomeHeading = 'Welcome to AniVerse2'
    Shot $welcomeHandle 'welcome'
    [void][BrandingWindow]::PostMessageW($welcomeHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    for ($waited = 0; $waited -lt 10000 -and !$proc.HasExited; $waited += 100) {
        $confirm = NamedElement ([Windows.Automation.AutomationElement]::RootElement) 'Yes' $proc.Id
        if ($confirm) { $confirm.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
        Start-Sleep -Milliseconds 100
    }
    $out.cancelled = $proc.HasExited
    $out.installFolderAbsent = !(Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'AniVerse2'))
    $out.passed = $out.splashTitle -eq 'AniVerse2 setup splash' -and !$out.welcomeVisibleBeforeSplash -and
        $out.welcomeHiddenDuringSplash -and $out.splashFrameChanged -and $out.skipInvoked -and $out.cancelled -and $out.installFolderAbsent
} catch {
    $out.error = $_.ToString()
    if ($splash) {
        $splash.Refresh()
        $out.splashExited = $splash.HasExited
        if ($splash.HasExited) { $out.splashExitCode = $splash.ExitCode }
    }
    $out.crashes = @(Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000,1026} -MaxEvents 8 -ErrorAction SilentlyContinue |
        Where-Object Message -Match 'AniVerse2SetupSplash' | Select-Object -ExpandProperty Message)
    $out.stack = $_.ScriptStackTrace
} finally {
    $out | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $GuestOutput 'result.json')
    Start-Process -FilePath "$env:WINDIR\System32\shutdown.exe" -ArgumentList '/s /t 0' -WindowStyle Hidden
}
