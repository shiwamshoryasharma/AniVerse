param([Parameter(Mandatory)][string]$Application)
$ErrorActionPreference = 'Stop'
$algorithm = [Security.Cryptography.HashAlgorithmName]::SHA256
$padding = [Security.Cryptography.RSASignaturePadding]::Pkcs1
$hash = (Get-FileHash -LiteralPath $Application -Algorithm SHA256).Hash.ToLowerInvariant()
$payload = [ordered]@{
  schema = 1
  role = 'aniverse-tauri-migration'
  target = 'windows-x64'
  version = '3.0.0'
  minimumElectron = '2.2.4'
  installerSha256 = '1' * 64
  installerBytes = 1
  applicationSha256 = $hash
}
$bytes = [Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress))
$key = [Security.Cryptography.RSA]::Create(2048)
try {
  $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
    'CN=AniVerse2 isolated test, O=AniVerse fixture', $key, $algorithm, $padding
  )
  $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1), [DateTimeOffset]::UtcNow.AddHours(1))
  try {
    [ordered]@{
      pin = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($certificate.RawData))
      release = [ordered]@{
        manifest = [Convert]::ToBase64String($bytes)
        signature = [Convert]::ToBase64String($key.SignData($bytes, $algorithm, $padding))
        certificate = [Convert]::ToBase64String($certificate.RawData)
      }
    } | ConvertTo-Json -Compress
  } finally { $certificate.Dispose() }
} finally { $key.Dispose() }
