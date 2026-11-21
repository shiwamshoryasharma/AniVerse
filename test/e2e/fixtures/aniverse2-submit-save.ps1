param([int]$AppPid,[string]$Destination)
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
        if(![OwnedSaveQa]::PostMessage($handle,0x111,[IntPtr]1,[IntPtr]::Zero)) {throw 'Could not invoke Save on the fixture dialog.'}
        exit 0
    }
    Start-Sleep -Milliseconds 150
}
throw 'The Save MP4 dialog did not open for the isolated app.'
