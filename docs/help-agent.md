# Documentation and help agent

The main toolbar's **Documentation** link opens `web/help.html` in a new tab, preserving the active analysis. It contains the built-in interface guide and complete pilot SOPs. The same guide is linked from **Help agent**. Repository readers can use [help.md](help.md) and [workflow-sops.md](workflow-sops.md).

In **Assistant**, configure shared provider settings under **Ask for a plan**, then expand **Help agent**. Ask an interface/workflow question without importing a measurement. Requests include your question, bounded conversation history, curated interface topics and pilot SOPs. They do not include selected source metadata, images, analysis results or DOM text. Avoid putting private information in your question if you do not intend to send it to the provider.

The help agent has no tools. Its plain-text answer must cite 1–8 known topic IDs; the browser supplies the corresponding documentation links and **Show control** buttons. Unknown IDs, incomplete responses, tool calls and credential reflections reject. Model prose can still be incorrect: citations establish which guide topics were selected, not that every statement is entailed. Follow the documented controls and assumptions.

**New help conversation** clears conversational context while retaining request audits. **Download help audit** exports credential-free messages and validated answers; **Cancel help** aborts a request. A session retains up to 16 requests, 12 history messages and 16,000 history characters. Help and analysis have separate conversation/audit state and share only connection fields. No credentials or conversation state are saved in persistent browser storage.

The adapter uses the documented Chat Completions JSON protocol and the same host-origin/CORS constraints as [provider settings](provider-compatibility.md). Requests are capped at 64 KiB, responses at 1 MiB and timeout at 60 seconds by default. Tests use mocked providers only.
