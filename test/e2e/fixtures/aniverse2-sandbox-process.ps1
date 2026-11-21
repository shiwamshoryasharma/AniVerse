$ErrorActionPreference = 'Stop'
$profile = $env:ANIVERSE2_SANDBOX_PROFILE
if (!$profile -or $profile -notlike '*\test\cache\aniverse2\sandbox-*\profile') {
    throw 'A disposable AniVerse2 sandbox fixture profile is required.'
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WebViewToken {
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherited, uint pid);
    [DllImport("advapi32.dll")] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int length, out int needed);
    [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private const int TokenIntegrityLevel = 25;
    private const int TokenIsAppContainer = 29;

    public static int[] Read(uint pid) {
        var result = new[] { -1, -1 };
        var process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return result;
        try {
            IntPtr token;
            if (!OpenProcessToken(process, 8, out token)) return result;
            try {
                int bytes;
                GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out bytes);
                if (bytes <= 0) return result;
                var data = Marshal.AllocHGlobal(bytes);
                try {
                    if (GetTokenInformation(token, TokenIntegrityLevel, data, bytes, out bytes)) {
                        var sid = Marshal.ReadIntPtr(data);
                        var count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                        if (count > 0) result[0] = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
                    }
                    if (GetTokenInformation(token, TokenIsAppContainer, data, 4, out bytes)) result[1] = Marshal.ReadInt32(data);
                } finally { Marshal.FreeHGlobal(data); }
            } finally { CloseHandle(token); }
        } finally { CloseHandle(process); }
        return result;
    }
}
'@
$mainPath = Join-Path $profile 'webview'
$sourcePath = Join-Path $profile 'site-webviews'
$unsafe = '(?:^|\s|")--(?:no-sandbox|disable-web-security|disable-site-isolation-trials|allow-file-access-from-files)(?=$|\s|"|=)'
$observed = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" | ForEach-Object {
    $command = $_.CommandLine
    if (!$command) { return }
    $group = if ($command.IndexOf($mainPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) { 'main' }
        elseif ($command.IndexOf($sourcePath, [StringComparison]::OrdinalIgnoreCase) -ge 0) { 'source' }
        else { return }
    $renderer = $command -match '(?:^|\s)--type=renderer(?=$|\s)'
    $token = if ($renderer) { [WebViewToken]::Read($_.ProcessId) }
    [pscustomobject]@{ group=$group; renderer=$renderer; unsafeFlags=[bool]($command -match $unsafe);
        integrityRid=if($renderer -and $token[0] -ge 0){$token[0]}else{$null};
        appContainer=if($renderer -and $token[1] -ge 0){[bool]$token[1]}else{$null} }
})
ConvertTo-Json -Compress -InputObject $observed
