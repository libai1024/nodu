$root='D:\nodu-esp32-20261029'
$env:NODU_PROFILE_DIR="$root\nodu-ui-profile"
$env:NODU_ARDUINO_HOME="$root\arduino-home"
$env:NODU_ARDUINO_RESOURCES="$root\app\scope-extension\resources\arduino"
$env:NODU_ARDUINO_OFFLINE_BUNDLES="$root\bundles"
$env:NODU_EMBEDDED_HOME="$root\nodu-ui-embedded"
$env:NODU_EMBEDDED_BIN="$root\tools\nodu-embedded-fixed.exe"
$env:NODU_RESOURCES_HOME="$root\nodu-ui-resources"
$env:NODU_PROJECTS_DIR="$root\projects with spaces"
$env:APPDATA="$root\appdata"; $env:LOCALAPPDATA="$root\localappdata"
$env:TEMP="$root\temp"; $env:TMP=$env:TEMP
$p=Start-Process 'D:\Nodu-STM32\Nodu.exe' -ArgumentList @('"D:\nodu-esp32-20261029\projects with spaces\nodu_esp32c3"','--remote-debugging-port=19230','--remote-debugging-address=127.0.0.1') -RedirectStandardOutput "$root\evidence\nodu-ui-stdout.txt" -RedirectStandardError "$root\evidence\nodu-ui-stderr.txt" -PassThru
$p.Id | Out-File "$root\evidence\nodu-ui-pid.txt"
