; NSIS installer for the hp-scan Windows helper.
;
; Built from macOS with `makensis` (brew install makensis), so no Windows
; machine is needed to produce it.
;
; Design notes:
;  - Installs per-machine and asks for admin once, purely so it can add the
;    Windows Firewall rule mDNS discovery needs. Without that rule the user
;    gets a confusing security popup the first time they scan, and discovery
;    silently fails if they dismiss it.
;  - Registers autostart under HKCU so the helper is always running and the
;    web app "just works" after a reboot.
;  - Launches through a WScript shim because the helper is cross-compiled from
;    macOS, where Bun cannot apply --windows-hide-console. The shim starts it
;    detached with no console window.

Unicode true

!define APP_NAME     "HP Scan Helper"
!define APP_ID       "hp-scan-helper"
!define APP_VERSION  "0.1.0"
!define PUBLISHER    "hp-scan"
!define WEB_APP_URL  "https://hp-scan.vercel.app/"
!define EXE_NAME     "hp-scan-helper.exe"
!define VBS_NAME     "start-helper.vbs"
!define FIREWALL_RULE "HP Scan Helper (mDNS discovery)"

Name "${APP_NAME}"
OutFile "..\dist\hp-scan-helper-setup.exe"
InstallDir "$PROGRAMFILES64\${APP_NAME}"
InstallDirRegKey HKLM "Software\${APP_ID}" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
ShowInstDetails show

VIProductVersion "0.1.0.0"
VIAddVersionKey "ProductName"     "${APP_NAME}"
VIAddVersionKey "CompanyName"     "${PUBLISHER}"
VIAddVersionKey "FileDescription" "Installer for ${APP_NAME}"
VIAddVersionKey "FileVersion"     "${APP_VERSION}"
VIAddVersionKey "ProductVersion"  "${APP_VERSION}"
VIAddVersionKey "LegalCopyright"  "${PUBLISHER}"

!include "MUI2.nsh"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchHelper
!define MUI_FINISHPAGE_RUN_TEXT "Start the scan helper now"
!define MUI_FINISHPAGE_SHOWREADME "${WEB_APP_URL}"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Open the scan page"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_FINISHPAGE_TEXT "The scan helper is installed and will start automatically each time you sign in.$\r$\n$\r$\nTo scan, just open ${WEB_APP_URL}"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Function LaunchHelper
  ; Launch as the logged-in user, not elevated, so the HKCU autostart entry and
  ; this first run behave identically.
  Exec '"$SYSDIR\wscript.exe" "$INSTDIR\${VBS_NAME}"'
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"

  ; Stop any previous copy so the file isn't locked.
  nsExec::Exec 'taskkill /F /IM "${EXE_NAME}"'
  Pop $0

  File "/oname=${EXE_NAME}" "..\dist\hp-scan-helper-win-x64.exe"

  ; Editable origin allowlist — lets the hosted app move to a new domain
  ; without rebuilding or reinstalling the helper.
  FileOpen $0 "$INSTDIR\hp-scan.config.json" w
  FileWrite $0 '{$\r$\n'
  FileWrite $0 '  "allowedOrigins": [$\r$\n'
  FileWrite $0 '    "${WEB_APP_URL}"$\r$\n'
  FileWrite $0 '  ]$\r$\n'
  FileWrite $0 '}$\r$\n'
  FileClose $0

  ; Shim that starts the helper detached and windowless.
  FileOpen $0 "$INSTDIR\${VBS_NAME}" w
  FileWrite $0 'Set s = CreateObject("WScript.Shell")$\r$\n'
  FileWrite $0 's.CurrentDirectory = "$INSTDIR"$\r$\n'
  FileWrite $0 's.Run """$INSTDIR\${EXE_NAME}""", 0, False$\r$\n'
  FileClose $0

  ; mDNS needs to receive multicast on UDP 5353.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FIREWALL_RULE}"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${FIREWALL_RULE}" dir=in action=allow protocol=UDP localport=5353 program="$INSTDIR\${EXE_NAME}" enable=yes profile=private,domain'
  Pop $0

  ; Start with Windows, for the signed-in user.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}" '"$SYSDIR\wscript.exe" "$INSTDIR\${VBS_NAME}"'

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Scan.lnk" "${WEB_APP_URL}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Start scan helper.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\${VBS_NAME}"'
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk" "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\Scan.lnk" "${WEB_APP_URL}"

  WriteRegStr HKLM "Software\${APP_ID}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoRepair" 1

  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM "${EXE_NAME}"'
  Pop $0

  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FIREWALL_RULE}"'
  Pop $0

  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
  DeleteRegKey HKLM "Software\${APP_ID}"

  Delete "$INSTDIR\${EXE_NAME}"
  Delete "$INSTDIR\${VBS_NAME}"
  Delete "$INSTDIR\hp-scan.config.json"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\${APP_NAME}\Scan.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Start scan helper.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\Scan.lnk"
SectionEnd
