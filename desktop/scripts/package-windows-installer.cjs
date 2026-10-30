// SPDX-License-Identifier: MIT
'use strict';
// Assemble an entirely offline installer from an already validated portable build.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const quote = value => String(value).replace(/\$/g, '$$$$').replace(/"/g, '$\\"');
function scriptFor({ archive, output, version, profile = 'stm32', assemblyScript }) {
    if (!['stm32', 'full'].includes(profile)) throw new Error('Unsupported installer profile');
    const full = profile === 'full';
    const label = full ? 'STM32 / ESP32' : 'STM32';
    const directory = full ? 'Nodu' : 'Nodu-STM32';
    const registry = full ? 'Nodu' : 'NoduSTM32';
    const payload = assemblyScript ? `File /oname=.nodu-assemble.ps1 "${quote(assemblyScript)}"
  ExecWait '$\\"$WINDIR\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe$\\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\\"$INSTDIR\\.nodu-assemble.ps1$\\" -SourceDirectory $\\"$EXEDIR$\\" -Destination $\\"$INSTDIR\\.nodu-payload.zip$\\"' $0
  Delete "$INSTDIR\\.nodu-assemble.ps1"
  \${If} $0 != 0
    MessageBox MB_ICONSTOP "离线安装文件缺失或校验失败。请将全部分卷与安装器放在同一目录，再次运行安装器。" /SD IDOK
    SetErrorLevel 1
    Quit
  \${EndIf}` : `File /oname=.nodu-payload.zip "${quote(archive)}"`;
    return `Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
Name "见微 Nodu ${label} ${quote(version)}"
OutFile "${quote(output)}"
InstallDir "D:\\${directory}"
RequestExecutionLevel admin
SetCompress off
CRCCheck on
ShowInstDetails show
ShowUninstDetails show
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "安装完整的 ${label} 离线开发环境。安装完成即可编写、补全、编译和烧写，无需下载工具链。$\\r$\\n$\\r$\\n应用、工程、配置和缓存保存在所选盘。设备驱动由 Windows 管理。${assemblyScript ? '$\\r$\\n请将全部分卷与安装器放在同一目录。' : ''}"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TEXT "安装完成。打开安装目录中的 Nodu.exe，即可新建 ${full ? 'STM32、ESP32-C3 或 ESP32-S3' : 'STM32F103C8T6'} 工程。"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Function .onInit
  \${IfNot} \${RunningX64}
    MessageBox MB_ICONSTOP "此安装包需要 64 位 Windows。" /SD IDOK
    SetErrorLevel 1
    Quit
  \${EndIf}
  SetRegView 64
  \${GetParameters} $R0
  ClearErrors
  \${GetOptions} $R0 "/NO_DRIVERS" $R1
  \${IfNot} \${Errors}
    SectionSetFlags 1 0
  \${EndIf}
FunctionEnd
Function .onVerifyInstDir
  StrCpy $0 $INSTDIR 3
  \${If} $0 == "C:\\"
    Abort
  \${EndIf}
  StrCpy $0 $INSTDIR 1 1
  \${If} $0 != ":"
    Abort
  \${EndIf}
FunctionEnd
Section "Nodu 与 ${label} 开发工具（必需）" AppSection
  SectionIn RO
  StrCpy $0 $INSTDIR 3
  \${If} $0 == "C:\\"
    MessageBox MB_ICONSTOP "请选择 D 盘或其他非 C 盘目录。" /SD IDOK
    SetErrorLevel 1
    Quit
  \${EndIf}
  SetOutPath "$INSTDIR"
  ${payload}
  ExecWait '$\\"$WINDIR\\Sysnative\\tar.exe$\\" -xf $\\"$INSTDIR\\.nodu-payload.zip$\\" -C $\\"$INSTDIR$\\" --strip-components 1' $0
  \${If} $0 != 0
    Delete "$INSTDIR\\.nodu-payload.zip"
    MessageBox MB_ICONSTOP "解压失败（$0），请检查剩余磁盘空间并重新安装。" /SD IDOK
    SetErrorLevel 1
    Quit
  \${EndIf}
  Delete "$INSTDIR\\.nodu-payload.zip"
  File /oname=NSIS-LICENSE.txt "\${NSISDIR}\\COPYING"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${registry}" "DisplayName" "见微 Nodu ${label}"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${registry}" "DisplayVersion" "${quote(version)}"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${registry}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${registry}" "UninstallString" '$\\"$INSTDIR\\Uninstall.exe$\\"'
  WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${registry}" "NoModify" 1
  WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${registry}" "NoRepair" 1
SectionEnd
Section "${full ? 'ST-LINK 与 CH343' : 'ST-LINK'} 离线驱动" DriversSection
  ExecWait '$\\"$WINDIR\\Sysnative\\pnputil.exe$\\" /add-driver $\\"$INSTDIR\\drivers\\ST-LINK\\*.inf$\\" /subdirs /install' $0
  FileOpen $1 "$INSTDIR\\driver-install-result.txt" w
  FileWrite $1 "pnputil exit code: $0$\\r$\\n"
  FileClose $1
  \${If} $0 == 3010
    SetRebootFlag true
  \${ElseIf} $0 != 0
    MessageBox MB_ICONEXCLAMATION "ST-LINK 驱动安装未完成（$0）。可稍后以管理员身份运行 drivers\\Install-ST-LINK.cmd，无需联网。" /SD IDOK
  \${EndIf}
  ${full ? `ExecWait '$\\"$WINDIR\\Sysnative\\pnputil.exe$\\" /add-driver $\\"$INSTDIR\\drivers\\CH343\\*.inf$\\" /subdirs /install' $0
  FileOpen $1 "$INSTDIR\\ch343-driver-install-result.txt" w
  FileWrite $1 "pnputil exit code: $0$\\r$\\n"
  FileClose $1
  \${If} $0 == 3010
    SetRebootFlag true
  \${ElseIf} $0 != 0
    MessageBox MB_ICONEXCLAMATION "CH343 驱动安装未完成（$0）。可稍后以管理员身份运行 drivers\\Install-CH343.cmd，无需联网。" /SD IDOK
  \${EndIf}` : ''}
SectionEnd
Function un.onInit
  SetRegView 64
FunctionEnd
Section "Uninstall"
  ; Keep Data (including user projects and configuration) on uninstall.
  RMDir /r "$INSTDIR\\resources"
  RMDir /r "$INSTDIR\\locales"
  RMDir /r "$INSTDIR\\drivers"
  Delete "$INSTDIR\\*.exe"
  Delete "$INSTDIR\\*.dll"
  Delete "$INSTDIR\\*.pak"
  Delete "$INSTDIR\\*.dat"
  Delete "$INSTDIR\\*.bin"
  Delete "$INSTDIR\\*.json"
  Delete "$INSTDIR\\*.txt"
  Delete "$INSTDIR\\LICENSE*"
  DeleteRegKey HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${registry}"
  RMDir "$INSTDIR"
SectionEnd
`;
}
function sha256(file) {
    const hash = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
    try { let length; while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length)); }
    finally { fs.closeSync(fd); }
    return hash.digest('hex');
}

// Keep every downloadable asset below GitHub's 2 GiB per-file limit and the
// NSIS embedded-data limit. These are local files, never download URLs.
function splitArchive(archive, directory, partBytes = 1536 * 1024 * 1024) {
    if (!Number.isSafeInteger(partBytes) || partBytes <= 0 || partBytes >= 2 ** 31) throw new Error('Invalid part size');
    fs.mkdirSync(directory, { recursive: true });
    const input = fs.openSync(archive, 'r'), buffer = Buffer.alloc(Math.min(partBytes, 1024 * 1024));
    const total = fs.statSync(archive).size, parts = [];
    try {
        for (let offset = 0, index = 1; offset < total; index++) {
            const name = `${path.basename(archive)}.${String(index).padStart(3, '0')}`;
            const output = fs.openSync(path.join(directory, name), 'w'), hash = crypto.createHash('sha256');
            let size = 0;
            try {
                while (size < partBytes && offset < total) {
                    const read = fs.readSync(input, buffer, 0, Math.min(buffer.length, partBytes - size, total - offset), null);
                    if (!read) throw new Error('Unexpected end of portable archive');
                    const data = buffer.subarray(0, read);
                    fs.writeFileSync(output, data); hash.update(data); size += read; offset += read;
                }
            } finally { fs.closeSync(output); }
            parts.push({ name, size, sha256: hash.digest('hex') });
        }
    } finally { fs.closeSync(input); }
    if (!parts.length) throw new Error('Empty portable archive');
    return parts;
}

function assemblyScriptFor(parts, archiveSha256) {
    for (const part of parts) {
        if (!/^[A-Za-z0-9_.-]+$/.test(part.name) || !/^[a-f0-9]{64}$/.test(part.sha256) || !Number.isSafeInteger(part.size) || part.size <= 0) throw new Error('Invalid payload part');
    }
    if (!parts.length || !/^[a-f0-9]{64}$/.test(archiveSha256)) throw new Error('Invalid payload manifest');
    const encoded = Buffer.from(JSON.stringify(parts)).toString('base64');
    return `param([Parameter(Mandatory=$true)][string]$SourceDirectory, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$parts = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$created = $false
try {
    foreach ($part in $parts) {
        $file = Join-Path $SourceDirectory $part.name
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing part: $($part.name)" }
        if ((Get-Item -LiteralPath $file).Length -ne $part.size -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $part.sha256) { throw "Corrupt part: $($part.name)" }
    }
    $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $created = $true
    try {
        foreach ($part in $parts) {
            $inputFile = [IO.File]::OpenRead((Join-Path $SourceDirectory $part.name))
            try { $inputFile.CopyTo($output) } finally { $inputFile.Dispose() }
        }
    } finally { $output.Dispose() }
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne '${archiveSha256}') { throw 'Assembled archive digest mismatch' }
    exit 0
} catch {
    if ($created) { Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue }
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`;
}

function verifyIdentity(marker, info, portableManifest) {
    if (!['stm32', 'full'].includes(marker.profile) || marker.dataDirectory !== 'Data' || marker.profile !== info.profile || marker.profile !== portableManifest.profile) throw new Error('Expected matching formal portable input profiles');
    if (info.validationOnly || portableManifest.validationOnly || info.sourceDirty !== false || portableManifest.sourceDirty !== false) throw new Error('Validation-only or dirty builds cannot become release installers');
    if (!/^[a-f0-9]{40}$/.test(info.sourceCommit) || info.sourceCommit !== portableManifest.sourceCommit || info.version !== portableManifest.version) throw new Error('Portable archive source identity mismatch');
}

function main() {
    if (process.platform !== 'win32') throw new Error('Build this installer on Windows');
    const { values } = parseArgs({ options: { portable: { type: 'string' }, nsis: { type: 'string' }, output: { type: 'string' }, archive: { type: 'string' } } });
    const portable = path.resolve(values.portable || path.join(__dirname, '../dist/Nodu-STM32-win32-x64'));
    const marker = JSON.parse(fs.readFileSync(path.join(portable, 'NoduPortable.json'), 'utf8'));
    if (!['stm32', 'full'].includes(marker.profile) || marker.dataDirectory !== 'Data') throw new Error('Expected validated full or STM32 portable input');
    const info = JSON.parse(fs.readFileSync(path.join(portable, 'resources/app/build-info.json'), 'utf8'));
    if (fs.existsSync(path.join(portable, 'LOCAL-VALIDATION-ONLY.json'))) throw new Error('Local validation directories cannot become release installers');
    for (const relative of ['Nodu.exe', 'drivers/manifest.json', 'resources/app/scripts/portable-profile.cjs']) {
        if (!fs.statSync(path.join(portable, relative)).isFile()) throw new Error('Missing offline input: ' + relative);
    }
    const nsis = values.nsis || process.env.NODU_NSIS;
    if (!nsis || !path.isAbsolute(nsis)) throw new Error('NODU_NSIS must point to an installed or portable NSIS compiler');
    const profile = marker.profile, stem = `Nodu-${info.version}-${profile === 'stm32' ? 'stm32-' : ''}win32-x64`;
    const output = path.resolve(values.output || path.join(path.dirname(portable), `${stem}-setup.exe`));
    const script = path.join(path.dirname(output), `nodu-${profile}-installer.nsi`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const archive = path.resolve(values.archive || path.join(path.dirname(portable), `${stem}.zip`));
    const portableManifest = JSON.parse(fs.readFileSync(archive.replace(/\.zip$/, '.manifest.json'), 'utf8'));
    verifyIdentity(marker, info, portableManifest);
    if (portableManifest.sha256 !== sha256(archive)) throw new Error('Portable archive digest mismatch');
    if (profile === 'full') {
        require('./package-arduino.cjs').validateBundle(path.join(portable, 'resources/app/node_modules/@scope/studio-extension/resources/arduino/offline/win32-x64'), 'win32-x64');
    }
    let assemblyScript, parts = [];
    if (fs.statSync(archive).size >= 1900 * 1024 * 1024) {
        parts = splitArchive(archive, path.dirname(output));
        assemblyScript = path.join(path.dirname(output), `nodu-${profile}-assemble.ps1`);
        fs.writeFileSync(assemblyScript, '\ufeff' + assemblyScriptFor(parts, portableManifest.sha256));
    }
    fs.writeFileSync(script, '\ufeff' + scriptFor({ archive, output, version: info.version, profile, assemblyScript }));
    execFileSync(nsis, ['/V2', script], { stdio: 'inherit' });
    const manifest = { version: info.version, profile, targetPlatform: 'win32-x64', artifact: path.basename(output), size: fs.statSync(output).size, sha256: sha256(output), sourceCommit: info.sourceCommit, sourceDirty: info.sourceDirty, defaultDirectory: profile === 'full' ? 'D:\\Nodu' : 'D:\\Nodu-STM32', internetDownloads: false, portableArchiveSha256: portableManifest.sha256, bundledDrivers: profile === 'full' ? ['ST-LINK', 'CH343'] : ['ST-LINK'], payloadParts: parts, signing: 'unsigned installer', generatedAt: new Date().toISOString() };
    fs.writeFileSync(output.replace(/\.exe$/, '.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(output.replace(/\.exe$/, '.sha256'), [{ name: manifest.artifact, sha256: manifest.sha256 }, ...parts].map(item => `${item.sha256}  ${item.name}\n`).join(''));
    console.log(output);
}
if (require.main === module) main();
module.exports = { scriptFor, splitArchive, assemblyScriptFor, verifyIdentity, sha256 };
