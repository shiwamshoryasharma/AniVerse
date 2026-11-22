param([int]$AppPid,[string]$Destination,[string]$ExpectedName,[int]$DelayMilliseconds=0,[string]$StateFile,[switch]$Cancel)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$owner=Get-Process -Id $AppPid
$path=(Resolve-Path 'test/cache').Path
if($owner.Path -cne (Resolve-Path 'node_modules/electron/dist/electron.exe').Path -or !$Destination.StartsWith($path+'\',[StringComparison]::OrdinalIgnoreCase)) {
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
        $observedName=$null
        if($ExpectedName){
            $editFilter=[System.Windows.Automation.PropertyCondition]::new($uia::IsValuePatternAvailableProperty,$true)
            $values=@()
            $fieldDeadline=[datetime]::UtcNow.AddSeconds(4)
            do{
                foreach($edit in $item.FindAll($scope::Descendants,$editFilter)){
                    try{
                        $pattern=$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                        $value=[string]$pattern.Current.Value
                        $values+=@{name=[string]$edit.Current.Name;id=[string]$edit.Current.AutomationId;value=$value}
                        if($value -ceq $ExpectedName -or $value -ceq [IO.Path]::GetFileNameWithoutExtension($ExpectedName)){$observedName=$value;break}
                    }catch{}
                }
                if(!$observedName){Start-Sleep -Milliseconds 200}
            }while(!$observedName -and [datetime]::UtcNow -lt $fieldDeadline)
            if(!$observedName){if($StateFile){[IO.File]::WriteAllText($StateFile,(@{expected=$ExpectedName;observedEdits=$values}|ConvertTo-Json -Depth 4))};throw 'The real Save As filename did not match selected series/season/episode.'}
        }
        $state=[ordered]@{observedDefaultName=$observedName;openedUtc=[datetime]::UtcNow.ToString('o');delayMilliseconds=$DelayMilliseconds;cancel=[bool]$Cancel}
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
