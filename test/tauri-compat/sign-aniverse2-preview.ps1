param(
  [Parameter(Mandatory)][string]$Application,
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][string]$Output
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$config = Get-Content -LiteralPath (Join-Path $root 'config/signing.json') -Raw | ConvertFrom-Json
$cert = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $config.certificateSha1)
$fingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($cert.RawData))
if ($fingerprint -notin $config.updateSigners) { throw 'This signer is not trusted by the released Electron bridge.' }
foreach ($path in $Application,$Installer) {
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  if (!$signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -ne $cert.Thumbprint -or
      [int]$signature.Status -notin 0,1 -or !$signature.TimeStamperCertificate) {
    throw "Expected intact, timestamped AniVerse Authenticode signature on $path"
  }
}
$version = (Get-Content -LiteralPath (Join-Path $root 'native/aniverse2/tauri.conf.json') -Raw | ConvertFrom-Json).version
if ((Split-Path -Leaf $Installer) -cne "AniVerse-Tauri-Setup-$version-x64.exe") { throw 'Unexpected installer filename.' }
$manifest = [ordered]@{
  schema = 1
  role = 'aniverse-tauri-migration'
  target = 'windows-x64'
  version = $version
  minimumElectron = '2.2.4'
  installerSha256 = (Get-FileHash -LiteralPath $Installer).Hash.ToLowerInvariant()
  installerBytes = (Get-Item -LiteralPath $Installer).Length
  applicationSha256 = (Get-FileHash -LiteralPath $Application).Hash.ToLowerInvariant()
}
$bytes = [Text.Encoding]::UTF8.GetBytes(($manifest | ConvertTo-Json -Compress))
$key = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
if (!$key) { throw 'The AniVerse Windows signing key is unavailable.' }
try {
  $signature = $key.SignData($bytes, [Security.Cryptography.HashAlgorithmName]::SHA256,
    [Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $envelope = [ordered]@{
    manifest = [Convert]::ToBase64String($bytes)
    signature = [Convert]::ToBase64String($signature)
    certificate = [Convert]::ToBase64String($cert.RawData)
  }
  $target = [IO.Path]::GetFullPath($Output)
  [IO.File]::WriteAllText($target, ($envelope | ConvertTo-Json -Compress))
} finally { $key.Dispose() }