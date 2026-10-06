; SuDuo Windows 安装器的自定义部分（electron-builder 的 nsis.include）。
; 技术设计：docs/03_开发计划/客户端桌面应用-技术设计.md §三 决策 6。

; 自定义了 customCheckAppRunning 后，electron-builder 不再替我们引入下面两样，但默认检查 _CHECK_APP_RUNNING 要用。
!include "getProcessInfo.nsh"
Var pid

; 覆盖安装 / 卸载前：先请正在运行的 SuDuo 自己退出（它会优雅停止本机服务和 Codex），最多等 20 秒；
; 之后照常走 electron-builder 的默认检查，必要时结束安装目录下仍在运行的进程。
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      DetailPrint "$(appClosing)"
      Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit'
      StrCpy $R2 0
      ${Do}
        Sleep 1000
        IntOp $R2 $R2 + 1
        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${If} $R0 != 0
          ${Break}
        ${EndIf}
      ${LoopUntil} $R2 >= 20
    ${EndIf}
  ${EndIf}
  !insertmacro _CHECK_APP_RUNNING
!macroend

; 卸载时问一次是否同时删除本机数据（默认保留，需求 R8）；自动更新触发的卸载不问、不删。
!macro customUnInstall
  ${IfNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除 SuDuo 的本机数据（会话记录、设置、日志）？$\r$\n选「否」会保留它们，重新安装后可以接着用。$\r$\n$\r$\nAlso delete SuDuo's local data (sessions, settings, logs)?$\r$\nChoose No to keep it for a later reinstall." /SD IDNO IDNO +2
      RMDir /r "$LOCALAPPDATA\SuDuo Desktop"
  ${EndIf}
!macroend
