# Changelog

## Unreleased

## 0.2.0 - 2026-09-20

### Highlights

- Windows now supports tray-resident mode. Hide the main bar completely when it is not needed, then restore or hide it with a click on the TalkEcho tray icon. The tray menu also offers Dashboard and Quit actions, and its tooltip reflects recording state.
- Dictation setup and activation are more reliable, with dedicated speech-to-text provider and language configuration plus improvements to the Right Ctrl hotkey and startup timing.

### Security

- Provider API keys are now stored in the operating system credential manager instead of WebView localStorage. Existing provider settings are migrated on startup, and cURL templates retain only `{{API_KEY}}` plus an opaque credential reference.
- **Action required after upgrading:** rotate every provider key that was configured in an older TalkEcho release. The previous plaintext value may still exist in backups, synchronized folders, logs, or other historical copies even after TalkEcho migrates its live profile.
- Credential-manager storage reduces exposure when the application data directory is copied, backed up, or synchronized. It does not protect against malicious code running as the same signed-in user. In particular, Windows generic credentials are protected for that user with DPAPI but remain readable by processes acting as that user.
- Provider credentials are intentionally retained by the operating system across a normal TalkEcho uninstall/reinstall. Delete a key in TalkEcho before uninstalling if it should not remain in the credential manager.

### Improvements

- Meeting transcripts, question-and-answer content, AI replies, and Dashboard Markdown can now be selected and copied without making the surrounding window controls draggable or selectable.
- Main-bar and Dashboard visibility now follow an explicit lifecycle, so the app can stay available in the background without permanently occupying the desktop or taskbar.

### Fixes

- Fixed speech-to-text IPC deserialization for camelCase audio request fields.
