$ErrorActionPreference='Stop'
$path=$env:ANIVERSE2_FIXTURE_BROWSER_DATA
if ([string]::IsNullOrEmpty($path) -or $path -notlike '*\test\cache\aniverse2\rendering-*\profile\webview-*') {
    throw 'An isolated AniVerse2 browser data directory is required.'
}
$proof=@(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($path,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -notmatch '--type='
})
if ($proof.Count -ne 1) {throw 'The isolated browser process was not found.'}
if ($proof[0].CommandLine -match '(?:^|\s)--disable-gpu-compositing(?:\s|$)') {'stable'} else {'accelerated'}
if ($env:ANIVERSE2_CHECK_GPU -eq '1') {
    $arguments=$proof[0].CommandLine
    if ($arguments -match '(?:^|\s)--force_high_performance_gpu(?:\s|$)') {'high-performance'}
    elseif ($arguments -match '(?:^|\s)--force_low_power_gpu(?:\s|$)') {'power-saving'}
    else {'system'}
}
