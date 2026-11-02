; AnyCompresssionThatMayWork 安装器钩子
; 作用：卸载时彻底清理“打开方式”登记，不留任何残留
; 说明：安装时不写入任何关联，是否出现在“右键 -> 打开方式”由用户在设置里自己开关

!define ASSOC_PROGID "AnyCompresssionThatMayWork.Archive"
!define ASSOC_APPEXE "AnyCompresssionThatMayWork.exe"

!macro NSIS_HOOK_POSTINSTALL
  ; 不做任何自动关联：不抢默认程序，也不偷偷写注册表
  ; 需要时由用户在应用内“设置 -> 在打开方式里显示”手动开启
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 顺手清掉运行期生成的 WebView2 缓存目录（未占用时可删）
  RMDir /r "$INSTDIR\data"

  ; 旧版本留在用户目录下的 WebView2 数据目录，一并清理
  RMDir /r "$LOCALAPPDATA\com.anythingthatmaywork.app"
  RMDir /r "$LOCALAPPDATA\com.anycompresssionthatmaywork.app"

  DeleteRegValue SHELL_CONTEXT "Software\Classes\.zip\OpenWithProgids" "${ASSOC_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.tar\OpenWithProgids" "${ASSOC_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.gz\OpenWithProgids" "${ASSOC_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.tgz\OpenWithProgids" "${ASSOC_PROGID}"

  DeleteRegKey SHELL_CONTEXT "Software\Classes\${ASSOC_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${ASSOC_APPEXE}"

  ; 旧版本命名的“打开方式”登记，避免升级后残留
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.zip\OpenWithProgids" "AnythingThatMayWork.Archive"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.tar\OpenWithProgids" "AnythingThatMayWork.Archive"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.gz\OpenWithProgids" "AnythingThatMayWork.Archive"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.tgz\OpenWithProgids" "AnythingThatMayWork.Archive"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\AnythingThatMayWork.Archive"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\AnythingThatMayWork.exe"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
