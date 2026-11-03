; ByTune joins "Open with" for the audio files it plays. Offered only, never
; made the default: the extensions' own default stays the user's choice (the
; association electron-builder would write takes it over). The extension list
; matches electron/audio-types.ts (PLAYABLE_AUDIO); a test keeps them in step.

!macro ByTuneOfferFor EXT
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "ByTune.Audio" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".${EXT}" ""
!macroend

!macro ByTuneWithdrawFrom EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "ByTune.Audio"
!macroend

!macro ByTuneEachAudioExtension MACRO
  !insertmacro ${MACRO} "mp3"
  !insertmacro ${MACRO} "m4a"
  !insertmacro ${MACRO} "aac"
  !insertmacro ${MACRO} "flac"
  !insertmacro ${MACRO} "ogg"
  !insertmacro ${MACRO} "oga"
  !insertmacro ${MACRO} "opus"
  !insertmacro ${MACRO} "wav"
  !insertmacro ${MACRO} "webm"
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\ByTune.Audio" "" "Audio file"
  WriteRegStr SHELL_CONTEXT "Software\Classes\ByTune.Audio\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\ByTune.Audio\shell\open" "" "Play with ByTune"
  WriteRegStr SHELL_CONTEXT "Software\Classes\ByTune.Audio\shell\open\command" "" '"$appExe" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$appExe" "%1"'
  !insertmacro ByTuneEachAudioExtension ByTuneOfferFor
  ; Let Explorer pick the new "Open with" entries up now.
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)"
!macroend

!macro customUnInstall
  !insertmacro ByTuneEachAudioExtension ByTuneWithdrawFrom
  DeleteRegKey SHELL_CONTEXT "Software\Classes\ByTune.Audio"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)"
!macroend
