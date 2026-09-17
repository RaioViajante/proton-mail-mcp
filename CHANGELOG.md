# Changelog

## 0.6.0 — Operational Hardening & Recovery

- Persist send, reply and forward receipt consumption in private, atomic filesystem markers shared by MCP processes.
- Add macOS bootstrap and read-only doctor for recovery and diagnostics.
- Add read-only `mail_system_status` so agents can identify the loaded runtime directly.
- Document Codex and Claude Code setup on the same Mac, replay crash semantics, and the future Linux/Windows roadmap.
- Keep the existing mailbox powers and permanent-delete live gate unchanged.
