$root='D:\nodu-esp32-20261029'
$existing='D:\nodu-f103-20261028\repo\desktop'
$env:NODU_ACCEPTANCE_ROOT=$root
$env:NODE_PATH="$existing\node_modules"
$env:NODU_ARDUINO_HOME="$root\arduino-home"
$env:NODU_ARDUINO_RESOURCES="$root\app\scope-extension\resources\arduino"
$env:NODU_ARDUINO_OFFLINE_BUNDLES="$root\bundles"
$env:NODU_EMBEDDED_HOME="$root\embedded-home"
$env:NODU_EMBEDDED_BIN="$existing\scope-extension\resources\bin\win32-x64\nodu-embedded.exe"
$env:NODU_STM32_TOOLKIT="$existing\scope-extension\resources\toolkits\stm32\win32-x64"
$env:TEMP="$root\temp"; $env:TMP=$env:TEMP
$env:USERPROFILE="$root\profile"; $env:APPDATA="$root\appdata"; $env:LOCALAPPDATA="$root\localappdata"
$env:PATH="$root\tools;C:\Windows\System32;C:\Windows"
Set-Location $root
$process=Start-Process "$root\tools\node.exe" -ArgumentList "$root\acceptance.cjs" -RedirectStandardOutput "$root\evidence\acceptance-console.txt" -RedirectStandardError "$root\evidence\acceptance-stderr.txt" -NoNewWindow -PassThru -Wait
exit $process.ExitCode
