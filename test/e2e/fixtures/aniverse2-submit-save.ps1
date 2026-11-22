param([int]$AppPid,[string]$Destination,[int]$DelayMilliseconds=0,[string]$StateFile,[switch]$Cancel)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$owner=Get-Process -Id $AppPid
$path=(Resolve-Path 'test/cache/aniverse2').Path
if(!$owner.Path.StartsWith($path+'\',[StringComparison]::OrdinalIgnoreCase) -or !$Destination.StartsWith($path+'\',[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Expected an isolated QA process and destination.'
}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class OwnedSaveQa {
    [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr target, uint message, IntPtr key, IntPtr other);
}
"@
$uia=[System.Windows.Automation.AutomationElement]
$scope=[System.Windows.Automation.TreeScope]
$pidFilter=[System.Windows.Automation.PropertyCondition]::new($uia::ProcessIdProperty,$AppPid)
$end=[datetime]::UtcNow.AddSeconds(14)
while([datetime]::UtcNow -lt $end) {
    foreach($item in $uia::RootElement.FindAll($scope::Children,$pidFilter)) {
        if($item.Current.Name -ne 'Save MP4 as') {continue}
        $handle=[IntPtr]$item.Current.NativeWindowHandle
        if($handle -eq [IntPtr]::Zero) {continue}
        // Never edit the filename: the saved output basename proves the app's default.
        $state=[ordered]@{openedUtc=[datetime]::UtcNow.ToString('o');delayMilliseconds=$DelayMilliseconds;cancel=[bool]$Cancel}
        if($StateFile){if(!$StateFile.StartsWith($path+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Dialog evidence must stay inside the isolated QA cache.'};[IO.File]::WriteAllText($StateFile,($state|ConvertTo-Json))}
        if($DelayMilliseconds -gt 0){Start-Sleep -Milliseconds $DelayMilliseconds}
        $state.submittedUtc=[datetime]::UtcNow.ToString('o')
        if($StateFile){[IO.File]::WriteAllText($StateFile,($state|ConvertTo-Json))}
        $action=if($Cancel){2}else{1}
        if(![OwnedSaveQa]::PostMessage($handle,0x111,[IntPtr]$action,[IntPtr]::Zero)) {throw 'Could not invoke Save on the fixture dialog.'}
        exit 0
    }
    Start-Sleep -Milliseconds 150
}
throw 'The Save MP4 dialog did not open for the isolated app.'
