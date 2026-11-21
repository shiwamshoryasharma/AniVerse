# Run inside Windows Sandbox with the normal Windows app and an empty profile.
param(
    [Parameter(Mandatory)][string]$AppPath,
    [Parameter(Mandatory)][string]$ReportPath
)
$ErrorActionPreference = 'Stop'
if ($env:USERNAME -ne 'WDAGUtilityAccount') {
    throw 'Use a disposable Windows Sandbox profile for this test.'
}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$elementType = [System.Windows.Automation.AutomationElement]
$node = [System.Windows.Automation.TreeScope]::Descendants
$invoke = [System.Windows.Automation.InvokePattern]::Pattern
$desktop = $elementType::RootElement
$report = [ordered]@{passed=$false; checks=[ordered]@{}}
$appProcess = $null

function Wait-Until([scriptblock]$Check, [string]$Failure, [int]$Seconds=25) {
    $until = [datetime]::UtcNow.AddSeconds($Seconds)
    do {
        try { $matching = & $Check } catch { $matching = $null }
        if ($matching) { return $matching }
        Start-Sleep -Milliseconds 250
    } while ([datetime]::UtcNow -lt $until)
    throw $Failure
}

function With-Name([string]$Name) {
    [System.Windows.Automation.PropertyCondition]::new($elementType::NameProperty, $Name)
}

try {
    $appProcess = Start-Process -FilePath $AppPath -PassThru
    $app = Wait-Until {
        $appProcess.Refresh()
        if ($appProcess.MainWindowHandle -ne [IntPtr]::Zero) {
            $main = $elementType::FromHandle($appProcess.MainWindowHandle)
            if ($main.FindFirst($node, (With-Name 'Settings'))) { $main }
        }
    } 'AniVerse2 Settings was unavailable.'
    foreach ($label in ('Settings', 'Accounts & sync')) {
        $button = Wait-Until { $app.FindFirst($node, (With-Name $label)) } "Cannot find $label."
        $button.GetCurrentPattern($invoke).Invoke()
    }

    $connect = With-Name 'Connect'
    $owner = [System.Windows.Automation.PropertyCondition]::new($elementType::ProcessIdProperty, $appProcess.Id)
    $protectedField = [System.Windows.Automation.PropertyCondition]::new($elementType::IsPasswordProperty, $true)
    $providerIndex = 0
    foreach ($provider in ('AniList','MyAnimeList')) {
        $button = Wait-Until {
            $rows = $app.FindAll($node, $connect)
            if ($rows.Count -eq 2 -and $rows[$providerIndex].Current.IsEnabled) { $rows[$providerIndex] }
        } "Connect was unavailable for $provider."
        $button.GetCurrentPattern($invoke).Invoke()
        $caption = [System.Windows.Automation.AndCondition]::new($owner, (With-Name "Sign in to $provider"))
        $guest = Wait-Until {
            $desktop.FindFirst([System.Windows.Automation.TreeScope]::Children, $caption)
        } "The $provider compatibility window did not open."
        $report.checks[$provider] = [ordered]@{opened=$true; loginForm=$false}
        try {
            [void](Wait-Until { $guest.FindFirst($node, $protectedField) } "$provider did not display a password field." 45)
            $report.checks[$provider].loginForm = $true
        } finally {
            try { $guest.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close() } catch {}
        }
        $providerIndex += 1
    }
    $report.passed = $true
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    [IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 4))
    if ($appProcess -and !$appProcess.HasExited) { $appProcess.CloseMainWindow() | Out-Null }
}
