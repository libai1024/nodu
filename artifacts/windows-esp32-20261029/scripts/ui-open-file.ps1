$root='D:\nodu-esp32-20261029'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$testAppId=[int](Get-Content "$root\evidence\arduino-ui-pid.txt")
$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$testAppId)
$windows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
$observed=@();$done=$false
foreach($window in $windows){
  $elements=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($element in $elements){
    $current=$element.Current
    $observed+=@{name=$current.Name;id=$current.AutomationId;type=$current.ControlType.ProgrammaticName}
    if($current.AutomationId -eq '1148' -and $current.ControlType -eq [System.Windows.Automation.ControlType]::Edit){
      $value=$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $value.SetValue('D:\nodu-esp32-20261029\projects with spaces\nodu_esp32c3\nodu_esp32c3.ino')
      $done=$true
    }
  }
  if($done){
    $button=$window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1')))
    if($button){$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()}
  }
}
@{selected=$done;observed=$observed}|ConvertTo-Json -Depth 5 | Out-File "$root\evidence\ui-open-file.json" -Encoding UTF8
