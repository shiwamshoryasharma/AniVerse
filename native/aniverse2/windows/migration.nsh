; Hand the signed Electron migration descriptor to the new executable before
; opening its window. Failed prep leaves the original AniVerse available.
!define ANIVERSE2_PROTOCOL "Software\Classes\aniverse2"
!define ANIVERSE2_CALLBACK "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --oauth-callback $\"%1$\""

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1
  ReadEnvStr $0 "ANIVERSE_ELECTRON_HANDOFF"
  ${If} $0 != ""
    ClearErrors
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --prepare-legacy-profile' $1
    ${If} ${Errors}
    ${OrIf} $1 != 0
      SetErrorLevel 1
      MessageBox MB_OK|MB_ICONSTOP "AniVerse2 could not prepare the old profile. You can reopen AniVerse with its original data." /SD IDOK
      Pop $1
      Pop $0
      Abort
    ${EndIf}
    System::Call 'Kernel32::SetEnvironmentVariableW(w "ANIVERSE_ELECTRON_HANDOFF", p 0) i .r1'
    ${If} $1 == 0
      SetErrorLevel 1
      Pop $1
      Pop $0
      Abort
    ${EndIf}
  ${EndIf}
  ; Keep any existing association, including a handler installed for all users.
  ClearErrors
  EnumRegKey $0 HKCR "aniverse2" 0
  ${If} ${Errors}
    ClearErrors
    EnumRegValue $0 HKCR "aniverse2" 0
    ${If} ${Errors}
      ClearErrors
      WriteRegStr HKCU "${ANIVERSE2_PROTOCOL}" "" "URL:AniVerse2 account sign-in"
      WriteRegStr HKCU "${ANIVERSE2_PROTOCOL}" "AniVerse2 Owner" "app.aniverse2.desktop"
      WriteRegStr HKCU "${ANIVERSE2_PROTOCOL}\shell\open\command" "" "${ANIVERSE2_CALLBACK}"
      WriteRegStr HKCU "${ANIVERSE2_PROTOCOL}" "URL Protocol" ""
      System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Push $0
  Push $1
  ReadRegStr $0 HKCU "${ANIVERSE2_PROTOCOL}\shell\open\command" ""
  ReadRegStr $1 HKCU "${ANIVERSE2_PROTOCOL}" "AniVerse2 Owner"
  ${If} $0 == "${ANIVERSE2_CALLBACK}"
  ${AndIf} $1 == "app.aniverse2.desktop"
    DeleteRegValue HKCU "${ANIVERSE2_PROTOCOL}\shell\open\command" ""
    DeleteRegKey /ifempty HKCU "${ANIVERSE2_PROTOCOL}\shell\open\command"
    DeleteRegKey /ifempty HKCU "${ANIVERSE2_PROTOCOL}\shell\open"
    DeleteRegKey /ifempty HKCU "${ANIVERSE2_PROTOCOL}\shell"
    DeleteRegValue HKCU "${ANIVERSE2_PROTOCOL}" "AniVerse2 Owner"
    DeleteRegValue HKCU "${ANIVERSE2_PROTOCOL}" "URL Protocol"
    DeleteRegValue HKCU "${ANIVERSE2_PROTOCOL}" ""
    DeleteRegKey /ifempty HKCU "${ANIVERSE2_PROTOCOL}"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
  ClearErrors
  Pop $1
  Pop $0
!macroend
