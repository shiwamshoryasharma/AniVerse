; Hand the signed Electron migration descriptor to the new executable before
; opening its window. Failed prep leaves the original AniVerse available.
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
  Pop $1
  Pop $0
!macroend
