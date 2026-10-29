$root='D:\nodu-esp32-20261029'
$env:USERPROFILE="$root\ide-profile"
$env:APPDATA="$root\ide-profile\AppData\Roaming"
$env:LOCALAPPDATA="$root\ide-profile\AppData\Local"
$env:TEMP="$root\temp"; $env:TMP=$env:TEMP
$env:ARDUINO_DIRECTORIES_DATA="$root\ide-data"
$env:ARDUINO_DIRECTORIES_DOWNLOADS="$root\ide-downloads"
$env:ARDUINO_DIRECTORIES_USER="$root\ide-sketchbook"
$arguments=@('--remote-debugging-port=19229','--remote-debugging-address=127.0.0.1','--disable-gpu',"--user-data-dir=$root\ide-userdata",'"D:\nodu-esp32-20261029\projects with spaces\nodu_esp32c3\nodu_esp32c3.ino"')
$p=Start-Process 'E:\Develop\Arduino IDE\Arduino IDE.exe' -ArgumentList $arguments -RedirectStandardOutput "$root\evidence\arduino-ui-stdout.txt" -RedirectStandardError "$root\evidence\arduino-ui-stderr.txt" -PassThru
$p.Id | Out-File "$root\evidence\arduino-ui-pid.txt"
