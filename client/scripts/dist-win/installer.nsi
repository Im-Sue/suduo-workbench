Unicode true
RequestExecutionLevel user
SetCompressor /SOLID zlib

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!ifndef VERSION
  !error "VERSION is required"
!endif
!ifndef VERSION4
  !error "VERSION4 is required"
!endif
!ifndef PAYLOAD_DIR
  !error "PAYLOAD_DIR is required"
!endif
!ifndef OUT_FILE
  !error "OUT_FILE is required"
!endif

Name "SuDuo"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\SuDuo"
InstallDirRegKey HKCU "Software\SuDuo" "InstallDir"
ShowInstDetails show
ShowUninstDetails show
BrandingText "SuDuo · 本机 Codex 驾驶舱"
Icon "${PAYLOAD_DIR}\assets\suduo.ico"
UninstallIcon "${PAYLOAD_DIR}\assets\suduo.ico"

VIProductVersion "${VERSION4}"
VIAddVersionKey /LANG=2052 "ProductName" "SuDuo"
VIAddVersionKey /LANG=2052 "CompanyName" "SuDuo Internal Pilot"
VIAddVersionKey /LANG=2052 "FileDescription" "SuDuo 离线安装器"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Internal pilot distribution"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "立即打开 SuDuo"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenSuDuo

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; 安装 = 放文件 + 快捷方式。不做 ACL 手术、不注册计划任务、不写剪贴板：
; %LOCALAPPDATA% 的默认继承权限本就仅限本人/SYSTEM/管理员，服务由启动器按需拉起。
Section "SuDuo" SEC_MAIN
  SetShellVarContext current
  SetOverwrite on

  ; 升级前先停掉正在运行的旧服务，否则覆盖被占用的 node.exe 会失败。
  ; 停服脚本释放到临时目录，用旧安装自带的 node 运行。
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=stop-suduo.mjs" "${PAYLOAD_DIR}\installer\stop-suduo.mjs"
  ${If} ${FileExists} "$INSTDIR\runtime\node.exe"
    DetailPrint "停止正在运行的 SuDuo 服务..."
    nsExec::ExecToLog '"$INSTDIR\runtime\node.exe" "$PLUGINSDIR\stop-suduo.mjs" "$INSTDIR"'
    Pop $0
  ${EndIf}

  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD_DIR}\*.*"

  WriteRegStr HKCU "Software\SuDuo" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SuDuo" "DisplayName" "SuDuo"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SuDuo" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SuDuo" "Publisher" "SuDuo Internal Pilot"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SuDuo" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SuDuo" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SuDuo" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SuDuo" "NoRepair" 1
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; 清理旧版遗留（自启计划任务、被收权的 config\codex）并迁移配置到 data\codex。
  ; 尽力而为：出现警告不阻断安装，服务端首次启动会自动生成令牌并补齐配置。
  DetailPrint "清理旧版本遗留并迁移配置..."
  nsExec::ExecToLog '"$INSTDIR\runtime\node.exe" "$INSTDIR\installer\install-runtime.mjs" "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "旧版本清理出现警告（代码 $0），详见 $INSTDIR\data\install.log，安装继续。"
  ${EndIf}

  ; 清理旧版本形态的快捷方式与遗留文件。
  CreateDirectory "$SMPROGRAMS\SuDuo"
  Delete "$SMPROGRAMS\SuDuo\SuDuo.lnk"
  Delete "$SMPROGRAMS\SuDuo\SuDuo 自检.lnk"
  Delete "$SMPROGRAMS\SuDuo\SuDuo.url"
  Delete "$SMPROGRAMS\SuDuo\SuDuo 自检.url"
  Delete "$DESKTOP\SuDuo.lnk"
  Delete "$DESKTOP\SuDuo.url"
  RMDir /r "$INSTDIR\bin"
  Delete "$INSTDIR\installer\open-suduo.ps1"
  Delete "$INSTDIR\installer\run-doctor.ps1"
  Delete "$INSTDIR\installer\start-suduo.ps1"
  Delete "$INSTDIR\installer\suduo-task.xml.template"

  ; 快捷方式直指捆绑 node.exe + 启动器（零 shell 包装，T13 杀软红线）。
  CreateShortCut "$SMPROGRAMS\SuDuo\SuDuo.lnk" "$INSTDIR\runtime\node.exe" '"$INSTDIR\installer\launcher.mjs"' "$INSTDIR\assets\suduo.ico" 0 SW_SHOWNORMAL "" "SuDuo · 本机 Codex 驾驶舱"
  CreateShortCut "$SMPROGRAMS\SuDuo\SuDuo 自检.lnk" "$INSTDIR\runtime\node.exe" '"$INSTDIR\installer\launcher.mjs" --doctor' "$INSTDIR\assets\suduo.ico" 0 SW_SHOWNORMAL "" "SuDuo 自检"
  CreateShortCut "$DESKTOP\SuDuo.lnk" "$INSTDIR\runtime\node.exe" '"$INSTDIR\installer\launcher.mjs"' "$INSTDIR\assets\suduo.ico" 0 SW_SHOWNORMAL "" "SuDuo"
  CreateShortCut "$SMPROGRAMS\SuDuo\卸载 SuDuo.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Function OpenSuDuo
  Exec '"$INSTDIR\runtime\node.exe" "$INSTDIR\installer\launcher.mjs"'
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  nsExec::ExecToLog '"$INSTDIR\runtime\node.exe" "$INSTDIR\installer\uninstall-runtime.mjs" "$INSTDIR"'
  Pop $0

  MessageBox MB_YESNO|MB_ICONQUESTION "是否保留本机会话、事件账本、访问令牌和 Codex 配置？选择“是”将保留 $INSTDIR\data。" IDYES keep_data IDNO purge_data

  purge_data:
    RMDir /r "$INSTDIR\data"
  keep_data:

  Delete "$DESKTOP\SuDuo.url"
  Delete "$DESKTOP\SuDuo.lnk"
  RMDir /r "$SMPROGRAMS\SuDuo"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SuDuo"
  DeleteRegKey HKCU "Software\SuDuo"

  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\assets"
  RMDir /r "$INSTDIR\config"
  RMDir /r "$INSTDIR\defaults"
  RMDir /r "$INSTDIR\installer"
  RMDir /r "$INSTDIR\runtime"
  Delete "$INSTDIR\bundle-manifest.json"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
