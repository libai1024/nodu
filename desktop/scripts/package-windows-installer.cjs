// SPDX-License-Identifier: MIT
'use strict';
// Assemble an entirely offline STM32 installer from an already validated portable build.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const quote = value => String(value).replace(/\$/g, '$$$$').replace(/"/g, '$\\"');
function scriptFor({ archive, output, version }) {
    return `Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
Name "见微 Nodu STM32 ${quote(version)}"
OutFile "${quote(output)}"
InstallDir "D:\\Nodu-STM32"
RequestExecutionLevel admin
SetCompress off
CRCCheck on
ShowInstDetails show
ShowUninstDetails show
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "安装完整的 STM32 离线开发环境。安装完成即可编写、补全、编译和使用 ST-LINK 烧写，无需下载工具链。$\\r$\\n$\\r$\\n应用、工程、配置和缓存保存在所选盘。设备驱动由 Windows 管理。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TEXT "安装完成。打开安装目录中的 Nodu.exe，即可新建 STM32F103C8T6 工程。"
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
Section "Nodu 与 STM32 开发工具（必需）" AppSection
  SectionIn RO
  StrCpy $0 $INSTDIR 3
  \${If} $0 == "C:\\"
    MessageBox MB_ICONSTOP "请选择 D 盘或其他非 C 盘目录。" /SD IDOK
    SetErrorLevel 1
    Quit
  \${EndIf}
  SetOutPath "$INSTDIR"
  File /oname=.nodu-payload.zip "${quote(archive)}"
  ExecWait '$\\"$WINDIR\\Sysnative\\tar.exe$\\" -xf $\\"$INSTDIR\\.nodu-payload.zip$\\" -C $\\"$INSTDIR$\\" --strip-components 1' $0
  \${If} $0 != 0
    MessageBox MB_ICONSTOP "解压失败（$0），请检查剩余磁盘空间并重新安装。" /SD IDOK
    SetErrorLevel 1
    Quit
  \${EndIf}
  Delete "$INSTDIR\\.nodu-payload.zip"
  File /oname=NSIS-LICENSE.txt "\${NSISDIR}\\COPYING"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NoduSTM32" "DisplayName" "见微 Nodu STM32"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NoduSTM32" "DisplayVersion" "${quote(version)}"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NoduSTM32" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NoduSTM32" "UninstallString" '$\\"$INSTDIR\\Uninstall.exe$\\"'
  WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NoduSTM32" "NoModify" 1
  WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NoduSTM32" "NoRepair" 1
SectionEnd
Section "ST-LINK 离线驱动" DriversSection
  ExecWait '$\\"$WINDIR\\Sysnative\\pnputil.exe$\\" /add-driver $\\"$INSTDIR\\drivers\\ST-LINK\\*.inf$\\" /subdirs /install' $0
  FileOpen $1 "$INSTDIR\\driver-install-result.txt" w
  FileWrite $1 "pnputil exit code: $0$\\r$\\n"
  FileClose $1
  \${If} $0 == 3010
    SetRebootFlag true
  \${ElseIf} $0 != 0
    MessageBox MB_ICONEXCLAMATION "ST-LINK 驱动安装未完成（$0）。可稍后以管理员身份运行 drivers\\Install-ST-LINK.cmd，无需联网。" /SD IDOK
  \${EndIf}
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
  DeleteRegKey HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NoduSTM32"
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
function main() {
    if (process.platform !== 'win32') throw new Error('Build this installer on Windows');
    const { values } = parseArgs({ options: { portable: { type: 'string' }, nsis: { type: 'string' }, output: { type: 'string' }, archive: { type: 'string' } } });
    const portable = path.resolve(values.portable || path.join(__dirname, '../dist/Nodu-STM32-win32-x64'));
    const marker = JSON.parse(fs.readFileSync(path.join(portable, 'NoduPortable.json'), 'utf8'));
    if (marker.profile !== 'stm32' || marker.dataDirectory !== 'Data') throw new Error('Expected validated STM32 portable input');
    const info = JSON.parse(fs.readFileSync(path.join(portable, 'resources/app/build-info.json'), 'utf8'));
    for (const relative of ['Nodu.exe', 'drivers/manifest.json', 'resources/app/scripts/portable-profile.cjs']) {
        if (!fs.statSync(path.join(portable, relative)).isFile()) throw new Error('Missing offline input: ' + relative);
    }
    const nsis = values.nsis || process.env.NODU_NSIS;
    if (!nsis || !path.isAbsolute(nsis)) throw new Error('NODU_NSIS must point to an installed or portable NSIS compiler');
    const output = path.resolve(values.output || path.join(path.dirname(portable), `Nodu-${info.version}-stm32-win32-x64-setup.exe`));
    const script = path.join(path.dirname(output), 'nodu-stm32-installer.nsi');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const archive = path.resolve(values.archive || path.join(__dirname, `../dist/Nodu-${info.version}-stm32-win32-x64.zip`));
    const portableManifest = JSON.parse(fs.readFileSync(archive.replace(/\.zip$/, '.manifest.json'), 'utf8'));
    if (portableManifest.profile !== 'stm32' || portableManifest.sha256 !== sha256(archive)) throw new Error('Portable archive digest or profile mismatch');
    fs.writeFileSync(script, '\ufeff' + scriptFor({ archive, output, version: info.version }));
    execFileSync(nsis, ['/V2', script], { stdio: 'inherit' });
    const manifest = { version: info.version, profile: 'stm32', targetPlatform: 'win32-x64', artifact: path.basename(output), size: fs.statSync(output).size, sha256: sha256(output), sourceCommit: info.sourceCommit, sourceDirty: info.sourceDirty, defaultDirectory: 'D:\\Nodu-STM32', internetDownloads: false, portableArchiveSha256: portableManifest.sha256, bundledDriver: 'ST-LINK', signing: 'unsigned installer', generatedAt: new Date().toISOString() };
    fs.writeFileSync(output.replace(/\.exe$/, '.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(output.replace(/\.exe$/, '.sha256'), `${manifest.sha256}  ${manifest.artifact}\n`);
    console.log(output);
}
if (require.main === module) main();
module.exports = { scriptFor };
