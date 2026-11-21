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
