param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][string]$TauriCli,
  [Parameter(Mandatory)][string]$Notes
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $root 'native/aniverse2/tauri.conf.json') -Raw | ConvertFrom-Json
$version = $config.version
$expected = "AniVerse-Tauri-Setup-$version-x64.exe"
if ($version -notmatch '^\d+\.\d+\.\d+$' -or (Split-Path -Leaf $Installer) -cne $expected) {
  throw 'Updater release version or installer filename is invalid.'
}
$cert = Get-Content -LiteralPath (Join-Path $root 'config/signing.json') -Raw | ConvertFrom-Json
$signature = Get-AuthenticodeSignature -LiteralPath $Installer
if ([int]$signature.Status -notin 0,1 -or $signature.SignerCertificate.Thumbprint -ne $cert.certificateSha1 -or !$signature.TimeStamperCertificate) {
  throw 'The installer must carry the timestamped AniVerse Windows signature before Tauri signing.'
}
$loadedLocally = !$env:TAURI_SIGNING_PRIVATE_KEY
if ($loadedLocally) {
  $vault = Join-Path $env:LOCALAPPDATA 'AniVerse2Signing'
  $public = [IO.File]::ReadAllText((Join-Path $vault 'windows-updater.pub')).Trim()
  if ($public -cne $config.plugins.updater.pubkey) { throw 'The updater key does not match the embedded public key.' }
  $opaque = [IO.File]::ReadAllText((Join-Path $vault 'windows-updater.dpapi'))
  $key = ConvertTo-SecureString $opaque
  $env:TAURI_SIGNING_PRIVATE_KEY = [Net.NetworkCredential]::new('', $key).Password
}
try {
  & $TauriCli signer sign --app-version $version $Installer *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Tauri update signing failed.' }
} finally {
  if ($loadedLocally) { Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue }
}
$signed = [IO.File]::ReadAllText($Installer + '.sig').Trim()
if (!$signed) { throw 'The Tauri updater signature is empty.' }
$release = 'https://github.com/shiwamshoryasharma/AniVerse/releases'
$manifest = [ordered]@{
  version = $version
  pub_date = [DateTimeOffset]::UtcNow.ToString('o')
  notes = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Notes).Path).Trim()
  platforms = @{
    'windows-x86_64' = @{
      url = "$release/download/aniverse2-v$version/$expected"
      signature = $signed
    }
  }
}
[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $Installer) 'latest.json'), ($manifest | ConvertTo-Json -Depth 6))