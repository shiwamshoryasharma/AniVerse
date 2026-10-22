; AniVerse installer customisation for electron-builder's assisted NSIS installer.
;
; Flow: Welcome (random wallpaper) → Install folder (any drive; path, free space and
; write access checked) → Shortcuts (desktop / Start Menu) → Installing (real progress
; from the 7-Zip extraction) → Finished (optional "Launch AniVerse now").
; Per-user install, no administrator rights unless the chosen folder needs them.
; App data (%APPDATA%\AniVerse: library, settings, encrypted accounts) is never touched.
;
; Art: build/installer/*.bmp, rendered by scripts/make-installer-art.cjs (npm run dist).

!include nsDialogs.nsh
!include LogicLib.nsh
!include WinMessages.nsh
!include FileFunc.nsh

!define AV_BG "0D0E17"
!define AV_PANEL "1C1E2E"
!define AV_TEXT "F2F3F8"
!define AV_MUTED "A3A8C3"
!define AV_ACCENT "A78BFA"
!define AV_WALLPAPERS 6

; Modern UI colours (header, welcome and finish pages)
!define MUI_BGCOLOR "${AV_BG}"
!define MUI_TEXTCOLOR "${AV_TEXT}"
!define MUI_ABORTWARNING
!define MUI_UNABORTWARNING

ManifestDPIAware true

; ---------------------------------------------------------------- shared helpers

; Width/height of a window's client area into $7/$8.
!macro AV_CLIENT_SIZE HWND
  System::Call '*(i,i,i,i) p .r9'
  System::Call 'user32::GetClientRect(p ${HWND}, p r9)'
  System::Call '*$9(i,i,i .r7,i .r8)'
  System::Free $9
!macroend

; Moves a control to percentages of the page size held in $7/$8.
!macro AV_PLACE CTRL X Y W H
  IntOp $0 $7 * ${X}
  IntOp $0 $0 / 100
  IntOp $1 $8 * ${Y}
  IntOp $1 $1 / 100
  IntOp $2 $7 * ${W}
  IntOp $2 $2 / 100
  IntOp $3 $8 * ${H}
  IntOp $3 $3 / 100
  System::Call 'user32::SetWindowPos(p ${CTRL}, p 0, i r0, i r1, i r2, i r3, i 0x14)'
!macroend

; Stretches the page's picture over the whole page (behind the text) and shows this run's wallpaper.
!macro AV_FULL_BLEED PAGE IMAGE BITMAP
  !insertmacro AV_CLIENT_SIZE ${PAGE}
  System::Call 'user32::SetWindowPos(p ${IMAGE}, p 1, i 0, i 0, i r7, i r8, i 0x10)'
  ${NSD_FreeImage} ${BITMAP}
  ${NSD_SetStretchedImage} ${IMAGE} "$PLUGINSDIR\av-welcome.bmp" ${BITMAP}
!macroend

; Extracts this run's wallpaper ($avWall = 1..6) into the plugins folder.
!macro AV_EXTRACT_CASE N
  ${Case} ${N}
    File "/oname=$PLUGINSDIR\av-welcome.bmp" "${BUILD_RESOURCES_DIR}\installer\welcome-${N}.bmp"
    File "/oname=$PLUGINSDIR\av-header.bmp" "${BUILD_RESOURCES_DIR}\installer\header-${N}.bmp"
    ${Break}
!macroend
!macro AV_PICK_WALLPAPER
  InitPluginsDir
  System::Call 'kernel32::GetTickCount() i .r0'
  IntOp $0 $0 % ${AV_WALLPAPERS}
  IntOp $avWall $0 + 1
  ${Switch} $avWall
    !insertmacro AV_EXTRACT_CASE 1
    !insertmacro AV_EXTRACT_CASE 2
    !insertmacro AV_EXTRACT_CASE 3
    !insertmacro AV_EXTRACT_CASE 4
    !insertmacro AV_EXTRACT_CASE 5
    !insertmacro AV_EXTRACT_CASE 6
  ${EndSwitch}
!macroend

; Hides the light etched separator lines; Modern UI shows them again on every page change.
!macro AV_HIDE_LINES
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1036
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1045
  ShowWindow $0 ${SW_HIDE}
!macroend

; "669 GB" / "512 MB" free on the drive of $2 ("D:\") into $3.
!macro AV_FREE_SPACE
  ${DriveSpace} $2 "/D=F /S=M" $3
  ${if} $3 >= 10240
    IntOp $3 $3 / 1024
    StrCpy $3 "$3 GB"
  ${else}
    StrCpy $3 "$3 MB"
  ${endif}
!macroend

; Dark window chrome: background, header picture, no etched lines, quiet branding text.
!macro AV_GUI_INIT_BODY
  SetCtlColors $HWNDPARENT ${AV_TEXT} ${AV_BG}
  !insertmacro AV_HIDE_LINES
  GetDlgItem $0 $HWNDPARENT 1028
  SetCtlColors $0 /BRANDING 5A5F7A ${AV_BG}
  GetDlgItem $0 $HWNDPARENT 1256
  SetCtlColors $0 /BRANDING 5A5F7A ${AV_BG}
  SetBrandingImage /IMGID=1046 /RESIZETOFIT "$PLUGINSDIR\av-header.bmp"
  CreateFont $avFontTitle "Segoe UI Semibold" 20 600
  CreateFont $avFontBold "Segoe UI Semibold" 10 600
!macroend

; Colours an inner page and its controls. Push buttons keep the Windows look;
; check boxes, radio buttons and group boxes drop visual styles so colours apply.
!macro AV_STYLE_DIALOG_FUNCTION UN
  Function ${UN}avStyleDialog
    Exch $0
    Push $1
    Push $2
    Push $3
    SetCtlColors $0 ${AV_TEXT} ${AV_BG}
    System::Call 'user32::GetWindow(p r0, i 5) p .r1'
    ${DoWhile} $1 != 0
      System::Call 'user32::GetClassNameW(p r1, w .r2, i 64)'
      ${If} $2 == "Edit"
        SetCtlColors $1 ${AV_TEXT} ${AV_PANEL}
      ${ElseIf} $2 == "Button"
        System::Call 'user32::GetWindowLongW(p r1, i -16) i .r3'
        IntOp $3 $3 & 0xF
        ${If} $3 > 1
          System::Call 'uxtheme::SetWindowTheme(p r1, w " ", w " ")'
          SetCtlColors $1 ${AV_TEXT} ${AV_BG}
        ${EndIf}
      ${ElseIf} $2 == "Static"
        SetCtlColors $1 ${AV_TEXT} ${AV_BG}
      ${ElseIf} $2 == "msctls_progress32"
        System::Call 'uxtheme::SetWindowTheme(p r1, w " ", w " ")'
        SendMessage $1 0x409 0 0xFA8BA7 ; PBM_SETBARCOLOR #A78BFA
        SendMessage $1 0x2001 0 0x2E1E1C ; PBM_SETBKCOLOR #1C1E2E
      ${EndIf}
      System::Call 'user32::GetWindow(p r1, i 2) p .r1'
    ${Loop}
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd
!macroend

; Progress page: themed, with the inner dialog found under the main window.
!macro AV_INSTFILES_SHOW_FUNCTION UN
  Function ${UN}avInstFilesShow
    !insertmacro AV_HIDE_LINES
    FindWindow $0 "#32770" "" $HWNDPARENT
    Push $0
    Call ${UN}avStyleDialog
  FunctionEnd
!macroend

; Run-time install mode: per-user (no admin), unless a machine-wide copy already exists.
!macro customInstallMode
  ${if} $hasPerMachineInstallation != "1"
    StrCpy $isForceCurrentInstall "1"
  ${endif}
!macroend

!ifndef BUILD_UNINSTALLER
; ================================================================ installer

Var avWall
Var avDesktop
Var avStartMenu
Var avInstallOk
Var avFontTitle
Var avFontBold
Var avShortcutsPage
Var avDesktopBox
Var avStartMenuBox

!define MUI_CUSTOMFUNCTION_GUIINIT avGuiInit
!insertmacro AV_STYLE_DIALOG_FUNCTION ""
!insertmacro AV_INSTFILES_SHOW_FUNCTION ""

!macro customInit
  !insertmacro AV_PICK_WALLPAPER
  StrCpy $avInstallOk "0"
  StrCpy $avDesktop ${BST_CHECKED}
  StrCpy $avStartMenu ${BST_CHECKED}
  ; Reinstall: keep whatever shortcuts the user has now.
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $0 != ""
    ${ifNot} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
      StrCpy $avDesktop ${BST_UNCHECKED}
    ${endIf}
    ${ifNot} ${FileExists} "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
      StrCpy $avStartMenu ${BST_UNCHECKED}
    ${endIf}
  ${endif}
  ${if} ${isNoDesktopShortcut}
    StrCpy $avDesktop ${BST_UNCHECKED}
  ${endif}
!macroend

; ---------------------------------------------------------------- welcome

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to AniVerse"
  !define MUI_WELCOMEPAGE_TEXT "A modern desktop home for anime: AniList-powered browsing and schedules, a built-in player and AniList / MyAnimeList sync.$\r$\n$\r$\nClick Next to choose where to install it."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW avWelcomeShow
  !insertmacro MUI_PAGE_WELCOME

  ; Defined after the first page: SetBrandingImage needs the header-image UI MUI just selected.
  Function avGuiInit
    !insertmacro AV_GUI_INIT_BODY
    ; fade the window in instead of popping
    System::Call 'user32::AnimateWindow(p $HWNDPARENT, i 200, i 0x80000)'
  FunctionEnd

  Function avWelcomeShow
    !insertmacro AV_HIDE_LINES
    !insertmacro AV_FULL_BLEED $mui.WelcomePage $mui.WelcomePage.Image $mui.WelcomePage.Image.Bitmap
    SetCtlColors $mui.WelcomePage.Title ${AV_TEXT} transparent
    SetCtlColors $mui.WelcomePage.Text D4D6E8 transparent
    SendMessage $mui.WelcomePage.Title ${WM_SETFONT} $avFontTitle 1
    !insertmacro AV_PLACE $mui.WelcomePage.Title 6 58 88 11
    !insertmacro AV_PLACE $mui.WelcomePage.Text 6 70 78 27
  FunctionEnd
!macroend

; ---------------------------------------------------------------- folder + shortcuts

!macro customPageAfterChangeDir
  !define MUI_PAGE_HEADER_TEXT "Choose where to install AniVerse"
  !define MUI_PAGE_HEADER_SUBTEXT "Any drive works: C:, D:, E: or another one."
  !define MUI_DIRECTORYPAGE_TEXT_TOP "AniVerse will be installed in the folder below. Click Browse to choose another drive or folder.$\r$\n$\r$\nYour library, settings and accounts are stored separately in your user profile and are kept when you reinstall, upgrade or uninstall."
  !define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Install folder"
  !define MUI_DIRECTORYPAGE_VERIFYONLEAVE
  !define MUI_PAGE_CUSTOMFUNCTION_PRE avSkipIfUpdated
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW avDirShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE avDirLeave
  !insertmacro MUI_PAGE_DIRECTORY

  Page custom avShortcutsCreate avShortcutsLeave

  ; The template inserts MUI_PAGE_INSTFILES right after this macro: style it too.
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW avInstFilesShow

  Function avSkipIfUpdated
    ${if} ${isUpdated}
      Abort
    ${endif}
  FunctionEnd

  Function avDirShow
    !insertmacro AV_HIDE_LINES
    Push $mui.DirectoryPage
    Call avStyleDialog
    SetCtlColors $mui.DirectoryPage.SpaceRequired ${AV_MUTED} ${AV_BG}
    SetCtlColors $mui.DirectoryPage.SpaceAvailable ${AV_MUTED} ${AV_BG}
  FunctionEnd

  ; Always install into its own AniVerse folder: D:\ → D:\AniVerse, D:\Games → D:\Games\AniVerse.
  Function avNormaliseDir
    Exch $9
    Push $1
    StrCpy $1 $9 1 -1
    ${if} $1 == "\"
      StrCpy $9 $9 -1
    ${endif}
    ${GetFileName} $9 $1
    ${if} $1 != "${APP_FILENAME}"
      StrCpy $9 "$9\${APP_FILENAME}"
    ${endif}
    Pop $1
    Exch $9
  FunctionEnd

  ; Validates the chosen folder before moving on: path, free space, write access.
  Function avDirLeave
    GetInstDirError $0
    ${if} $0 == 1
      MessageBox MB_ICONEXCLAMATION|MB_OK "That isn't a folder AniVerse can install to.$\r$\n$\r$\nChoose a folder on a local drive, for example D:\AniVerse."
      Abort
    ${endif}
    ; The folder box is the source of truth here (NSIS may copy it into $INSTDIR after this function).
    ${NSD_GetText} $mui.DirectoryPage.Directory $9
    Push $9
    Call avNormaliseDir
    Pop $9
    ${if} $0 == 2
      StrCpy $2 $9 3
      ${DriveSpace} $2 "/D=F /S=M" $3
      IntOp $4 ${APP_64_UNPACKED_SIZE} / 1024
      MessageBox MB_ICONEXCLAMATION|MB_OK "There isn't enough free space on $2.$\r$\n$\r$\nAniVerse needs about $4 MB; $3 MB is free. Free some space or choose another drive."
      Abort
    ${endif}
    ; Write test where the files will go. Folders created only for the test are removed again.
    StrCpy $5 $9
    ${DoUntil} ${FileExists} "$5\*.*"
      ${GetParent} $5 $5
      ${if} $5 == ""
        ${ExitDo}
      ${endif}
    ${Loop}
    ClearErrors
    CreateDirectory $9
    FileOpen $6 "$9\.aniverse-write-test" w
    ${if} ${Errors}
      StrCpy $6 ""
    ${else}
      FileClose $6
      Delete "$9\.aniverse-write-test"
      StrCpy $6 "ok"
    ${endif}
    ; remove the folders this check created (up to the one that already existed)
    StrCpy $1 $9
    ${DoWhile} $1 != $5
      ${if} $1 == ""
        ${ExitDo}
      ${endif}
      RMDir $1
      ${GetParent} $1 $1
    ${Loop}
    ${if} $6 != "ok"
      MessageBox MB_ICONEXCLAMATION|MB_OK "AniVerse can't write to:$\r$\n$9$\r$\n$\r$\nThis folder needs administrator rights. Choose a folder you own (for example D:\AniVerse or one inside your user folder), or run the installer as administrator."
      Abort
    ${endif}
    ${NSD_SetText} $mui.DirectoryPage.Directory $9
    StrCpy $INSTDIR $9
  FunctionEnd

  Function avShortcutsCreate
    ${if} ${isUpdated}
      Abort
    ${endif}
    Push $INSTDIR
    Call avNormaliseDir
    Pop $INSTDIR
    !insertmacro MUI_HEADER_TEXT "Shortcuts" "Choose where AniVerse appears, then click Install."
    nsDialogs::Create 1018
    Pop $avShortcutsPage
    ${if} $avShortcutsPage == error
      Abort
    ${endif}

    ${NSD_CreateLabel} 0 0 100% 10u "Install folder"
    Pop $0
    ${NSD_CreateLabel} 0 11u 100% 12u "$INSTDIR"
    Pop $1
    StrCpy $2 $INSTDIR 3
    !insertmacro AV_FREE_SPACE
    StrCpy $2 $INSTDIR 1
    IntOp $4 ${APP_64_UNPACKED_SIZE} / 1024
    ${NSD_CreateLabel} 0 25u 100% 10u "Space required: $4 MB   ·   Free on $2: $3"
    Pop $5
    ${NSD_CreateCheckbox} 0 46u 100% 12u "Create a desktop shortcut"
    Pop $avDesktopBox
    ${NSD_SetState} $avDesktopBox $avDesktop
    ${NSD_CreateCheckbox} 0 62u 100% 12u "Create a Start Menu shortcut"
    Pop $avStartMenuBox
    ${NSD_SetState} $avStartMenuBox $avStartMenu
    ${NSD_CreateLabel} 0 86u 100% 30u "AniVerse runs from this folder without administrator rights. Your library, settings and AniList / MyAnimeList connections live in your user profile and are kept on reinstall, upgrade and uninstall."
    Pop $6

    Push $avShortcutsPage
    Call avStyleDialog
    SetCtlColors $0 ${AV_MUTED} ${AV_BG}
    SetCtlColors $1 ${AV_ACCENT} ${AV_BG}
    SendMessage $1 ${WM_SETFONT} $avFontBold 1
    SetCtlColors $5 ${AV_MUTED} ${AV_BG}
    SetCtlColors $6 ${AV_MUTED} ${AV_BG}
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(^InstallBtn)"
    !insertmacro AV_HIDE_LINES
    nsDialogs::Show
  FunctionEnd

  Function avShortcutsLeave
    ${NSD_GetState} $avDesktopBox $avDesktop
    ${NSD_GetState} $avStartMenuBox $avStartMenu
  FunctionEnd
!macroend

; Applies the shortcut choices after electron-builder's own install steps.
!macro customInstall
  ${ifNot} ${isUpdated}
    ${if} $avDesktop == ${BST_CHECKED}
      ${ifNot} ${FileExists} "$newDesktopLink"
        CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      ${endIf}
    ${else}
      ${if} ${FileExists} "$newDesktopLink"
        WinShell::UninstShortcut "$newDesktopLink"
        Delete "$newDesktopLink"
      ${endIf}
    ${endIf}
    ${if} $avStartMenu == ${BST_CHECKED}
      ${ifNot} ${FileExists} "$newStartMenuLink"
        !insertmacro createMenuDirectory
        CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
      ${endIf}
      StrCpy $launchLink "$newStartMenuLink"
    ${else}
      ${if} ${FileExists} "$newStartMenuLink"
        WinShell::UninstShortcut "$newStartMenuLink"
        Delete "$newStartMenuLink"
      ${endIf}
      StrCpy $launchLink "$appExe"
    ${endIf}
  ${endIf}
  ; Reached only when every install step succeeded.
  StrCpy $avInstallOk "1"
!macroend

; ---------------------------------------------------------------- finish

!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_TITLE "AniVerse is ready"
  !define MUI_FINISHPAGE_TEXT "AniVerse was installed in:$\r$\n$INSTDIR$\r$\n$\r$\nYour library, settings and connected accounts carry over between versions."
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Launch AniVerse now"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW avFinishShow
  !insertmacro MUI_PAGE_FINISH

  Function avFinishShow
    !insertmacro AV_HIDE_LINES
    !insertmacro AV_FULL_BLEED $mui.FinishPage $mui.FinishPage.Image $mui.FinishPage.Image.Bitmap
    SetCtlColors $mui.FinishPage.Title ${AV_TEXT} transparent
    SetCtlColors $mui.FinishPage.Text D4D6E8 transparent
    SendMessage $mui.FinishPage.Title ${WM_SETFONT} $avFontTitle 1
    !insertmacro AV_PLACE $mui.FinishPage.Title 6 58 88 11
    !insertmacro AV_PLACE $mui.FinishPage.Text 6 69 88 19
    !insertmacro AV_PLACE $mui.FinishPage.Run 6 89 60 7
    System::Call 'uxtheme::SetWindowTheme(p $mui.FinishPage.Run, w " ", w " ")'
    SetCtlColors $mui.FinishPage.Run ${AV_TEXT} ${AV_BG}
    ; Only offer to launch after a successful installation.
    ${if} $avInstallOk != "1"
      ${NSD_Uncheck} $mui.FinishPage.Run
      ShowWindow $mui.FinishPage.Run ${SW_HIDE}
    ${endif}
  FunctionEnd
!macroend

!else
; ================================================================ uninstaller

Var avWall
Var avFontTitle
Var avFontBold

!define MUI_CUSTOMFUNCTION_UNGUIINIT un.avGuiInit
!insertmacro AV_STYLE_DIALOG_FUNCTION "un."
!insertmacro AV_INSTFILES_SHOW_FUNCTION "un."

!macro customUnInit
  !insertmacro AV_PICK_WALLPAPER
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Uninstall AniVerse"
  !define MUI_WELCOMEPAGE_TEXT "This removes the AniVerse app from $INSTDIR.$\r$\n$\r$\nYour library, history, settings and AniList / MyAnimeList connections stay in your user profile, so reinstalling later picks up where you left off."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.avWelcomeShow
  !insertmacro MUI_UNPAGE_WELCOME

  ; style the uninstall progress page that follows
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.avInstFilesShow

  Function un.avGuiInit
    !insertmacro AV_GUI_INIT_BODY
  FunctionEnd

  Function un.avWelcomeShow
    !insertmacro AV_HIDE_LINES
    !insertmacro AV_FULL_BLEED $mui.WelcomePage $mui.WelcomePage.Image $mui.WelcomePage.Image.Bitmap
    SetCtlColors $mui.WelcomePage.Title ${AV_TEXT} transparent
    SetCtlColors $mui.WelcomePage.Text D4D6E8 transparent
    SendMessage $mui.WelcomePage.Title ${WM_SETFONT} $avFontTitle 1
    !insertmacro AV_PLACE $mui.WelcomePage.Title 6 58 88 11
    !insertmacro AV_PLACE $mui.WelcomePage.Text 6 70 88 27
    ; the next page removes the app straight away: say so on the button
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(^UninstallBtn)"
  FunctionEnd
!macroend

; Inserted by the template right before MUI_UNPAGE_FINISH: same look as the welcome page.
!macro customUninstallPage
  !define MUI_FINISHPAGE_TITLE "AniVerse was uninstalled"
  !define MUI_FINISHPAGE_TEXT "Your library, history, settings and AniList / MyAnimeList connections are still in your user profile, so installing AniVerse again picks up where you left off.$\r$\n$\r$\nClick Finish to close."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.avFinishShow
!macroend

; Inserted by the template after all pages, once MUI has declared the finish page variables.
!macro customHeader
  Function un.avFinishShow
    !insertmacro AV_HIDE_LINES
    !insertmacro AV_FULL_BLEED $mui.FinishPage $mui.FinishPage.Image $mui.FinishPage.Image.Bitmap
    SetCtlColors $mui.FinishPage.Title ${AV_TEXT} transparent
    SetCtlColors $mui.FinishPage.Text D4D6E8 transparent
    SendMessage $mui.FinishPage.Title ${WM_SETFONT} $avFontTitle 1
    !insertmacro AV_PLACE $mui.FinishPage.Title 6 58 88 11
    !insertmacro AV_PLACE $mui.FinishPage.Text 6 70 88 27
  FunctionEnd
!macroend

; Removes the aniverse:// sign-in link handler when it points at this copy (not on upgrades).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadRegStr $0 HKCU "Software\Classes\aniverse\shell\open\command" ""
    ${if} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
      DeleteRegKey HKCU "Software\Classes\aniverse"
    ${endif}
  ${endIf}
!macroend

!endif
