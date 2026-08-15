; ============================================================================
; DeepSeek Harness — 自定义 NSIS 脚本（经 nsis.include 同时编译进安装器与卸载器）
;
; 安装器：customPageAfterChangeDir —— 选择安装目录后追加「数据位置说明」页
; 卸载器：customUnWelcomePage     —— 欢迎页改为「是否删除运行数据」选择页
;          （勾选后在 customUnInstall 中删除 %APPDATA%\dsh-desktop）
;
; 注意：本文件为构建期专用，不会被打进应用资源。
; ============================================================================

; 本文件在模板之前被解析（位于共享 header），MUI2/LogicLib 尚未引入，
; 因此需显式 include（两个文件都带防重入保护，后续 MUI2 再引入也安全）。
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; ============================================================================
; 安装器侧（仅安装器编译包含；避免「未引用」warning 被 -WX 当 error）
; 全局变量声明放在各自编译分支里（customHeader 在模板里晚于本文件才展开，
; 到那时函数早已解析完，变量会「未声明」）。
; ============================================================================
!ifndef BUILD_UNINSTALLER

!macro customPageAfterChangeDir
  Page custom DshInfoPage
!macroend

Function DshInfoPage
  ; 静默安装跳过本页（应用内静默更新/静默安装均走 /S，不会弹此页；
  ; GUI 安装与手动重装则正常显示说明）
  ${if} ${Silent}
    Abort
  ${endIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 16u "程序文件将安装到："
  Pop $0
  ${NSD_CreateLabel} 0 18u 100% 14u "$INSTDIR"
  Pop $0
  ${NSD_CreateLabel} 0 44u 100% 16u "运行数据（dsh 本体、插件、profile、设置、备份）将保存到："
  Pop $0
  ${NSD_CreateLabel} 0 62u 100% 14u "$APPDATA\${APP_PACKAGE_NAME}"
  Pop $0
  ${NSD_CreateLabel} 0 90u 100% 60u "Program Files 受系统保护，普通用户无法写入，因此运行数据按 Windows 惯例存放在用户数据目录（%AppData%）。$\r$\n$\r$\n卸载本应用时，可选择一并删除运行数据。"
  Pop $0

  nsDialogs::Show
FunctionEnd

!else

; ============================================================================
; 卸载器侧
; ============================================================================

Var /GLOBAL DshDeleteData
Var /GLOBAL DshDeleteDataCheckbox

!macro customUnWelcomePage
  Page custom DshAskDataPage DshAskDataPageLeave
!macroend

Function DshAskDataPage
  ${if} ${Silent}
    Abort
  ${endIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 16u "卸载 DeepSeek Harness"
  Pop $0
  ${NSD_CreateLabel} 0 28u 100% 16u "程序文件将从以下位置移除："
  Pop $0
  ${NSD_CreateLabel} 0 46u 100% 14u "$INSTDIR"
  Pop $0
  ${NSD_CreateLabel} 0 72u 100% 36u "运行数据（dsh 本体、插件、profile、设置、备份）位于：$\r$\n$APPDATA\${APP_PACKAGE_NAME}$\r$\n删除后，已安装的插件与全部配置将无法恢复。"
  Pop $0
  ${NSD_CreateCheckbox} 0 122u 100% 14u "同时删除运行数据（默认不勾选，推荐保留）"
  Pop $DshDeleteDataCheckbox
  ${NSD_SetState} $DshDeleteDataCheckbox ${BST_UNCHECKED}

  nsDialogs::Show
FunctionEnd

Function DshAskDataPageLeave
  ${NSD_GetState} $DshDeleteDataCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $DshDeleteData "1"
  ${Else}
    StrCpy $DshDeleteData "0"
  ${EndIf}
FunctionEnd

; 卸载器：默认保留数据（静默模式由模板内置 --delete-app-data 逻辑处理）
!macro customUnInit
  StrCpy $DshDeleteData "0"
!macroend

; 卸载器：勾选了「同时删除运行数据」才执行删除
!macro customUnInstall
  ${if} $DshDeleteData == "1"
    DetailPrint "正在删除运行数据：$APPDATA\${APP_PACKAGE_NAME}"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
  ${endIf}
!macroend

!endif
