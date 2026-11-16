# Security and privacy

## Reporting a vulnerability

Please report security problems privately through GitHub's "Report a vulnerability" feature on this repository rather than a public issue. Include the version, macOS version, and steps to reproduce.

## What Sidekick stores

- **Activity log.** One file in the VS Code extension's private storage (mode 0600). Each line has only `at` (timestamp), `event` (a hook event name), `session` and `workspace` (truncated SHA-256 hashes), and, for model-request events, `requestTokens`. It is trimmed automatically to the newest events. Prompts, transcripts, file paths, working folders, and tool payloads are never written.
- **Chat titles and conversation IDs** are read from the local Codex App Server while a deck is connected and held in memory only. Raw conversation IDs stay inside the VS Code extension host; the deck receives only hashed IDs. Chat keys can open only conversations matching the extension's recent-chat metadata or observed activity.
- **Account usage** (remaining percentages and reset times) is read the same way and held in memory only.
- **Settings.** VS Code stores, per folder, whether the connection is enabled.

Nothing is sent over the network by Sidekick.

## Hooks

Setup writes Sidekick's eight hook definitions to `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`). They run for every local Codex session on the machine, including the CLI and desktop app. Codex requires you to review and trust each hook; Sidekick never changes trust settings. An existing hooks file is never overwritten; Sidekick offers a merged draft instead. The recorder opens its log with `O_NOFOLLOW`, checks owner, mode and link count, and never returns a decision, so it cannot approve, deny, or alter a Codex action.

## Local bridge

The VS Code extension listens on a Unix socket in a per-user directory (`/tmp/codex-sidekick-<uid>`, mode 0700, socket 0600). Messages are size-limited and typed, and only a fixed allowlist of Codex commands can be requested (`openSidebar`, `newChat`, `newPanel`, and focusing or opening a known chat). This protects against other OS accounts. It does not defend against malicious software already running as you.

Chat selection opens a local link addressed to `openai.chatgpt` through VS Code's URI APIs. VS Code binds it to the connected window, and Codex's URI handler selects the sidebar conversation. Sidekick leaves VS Code's link confirmation and authorization settings under your control.

## Native dictation helper

The helper runs only for a key press, under Stream Deck's macOS Accessibility permission. It can read accessibility roles, button labels, geometry, and webview owner URLs in VS Code, and it can click one verified Codex microphone button, then restore the pointer. It never reads text fields, chat text, or source code, never captures audio, and refuses to act unless it identifies a single microphone in a webview owned by the official Codex extension in the connected workspace's window. Grant Accessibility access to Stream Deck only if you accept this.
