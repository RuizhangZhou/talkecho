# Provider credential storage

TalkEcho stores provider API keys through the Rust `keyring` crate. It maps to Windows Credential Manager, macOS Keychain, and Linux Secret Service. `keyring` was chosen instead of Stronghold because these credentials already have a natural operating-system account scope, users and administrators can manage them with native tools, and no additional vault password or vault-file lifecycle is required.

The WebView stores only a cURL template containing `{{API_KEY}}` and an opaque `secretRef`. The actual value is resolved in Rust immediately before the Rust HTTP client sends a provider request. The frontend API deliberately exposes only `set_secret`, `delete_secret`, and `has_secret`; it has no operation that returns a stored value.

On the first startup after upgrading, TalkEcho migrates recognizable credentials from custom provider templates, selected-provider objects, dictation settings, and per-provider variable maps. The migration writes credentials before replacing localStorage values and can be run repeatedly. If the OS credential store is unavailable, provider configuration is not loaded, preventing the legacy plaintext value from entering normal application state.

## Upgrade guidance

Rotate keys that were used with older TalkEcho releases. Migration cleans the active WebView profile, but it cannot erase plaintext copies already captured by backups, directory synchronization, diagnostic archives, or old logs.

OS credential managers improve protection against offline copying of the WebView data directory; they are not an absolute security boundary. A process running as the same signed-in user may be able to read that user's credentials. Windows generic credentials, for example, use user-bound DPAPI and can still be read through Credential Manager APIs by code executing as that user.

Credentials normally survive a TalkEcho uninstall/reinstall because they belong to the user's OS credential store. To remove one, use the Delete action beside the provider key before uninstalling, or remove the `com.talkecho.desktop.provider-secrets` entry with the operating system's credential-management tools.
