# Changelog

## Unreleased

### Security

- Provider API keys are now stored in the operating system credential manager instead of WebView localStorage. Existing provider settings are migrated on startup, and cURL templates retain only `{{API_KEY}}` plus an opaque credential reference.
- **Action required after upgrading:** rotate every provider key that was configured in an older TalkEcho release. The previous plaintext value may still exist in backups, synchronized folders, logs, or other historical copies even after TalkEcho migrates its live profile.
- Credential-manager storage reduces exposure when the application data directory is copied, backed up, or synchronized. It does not protect against malicious code running as the same signed-in user. In particular, Windows generic credentials are protected for that user with DPAPI but remain readable by processes acting as that user.
- Provider credentials are intentionally retained by the operating system across a normal TalkEcho uninstall/reinstall. Delete a key in TalkEcho before uninstalling if it should not remain in the credential manager.
