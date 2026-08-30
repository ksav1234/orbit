# Orbit

**AI that works inside your workspace.**

Orbit is a terminal-native, provider-agnostic AI coding agent. You bring your own
provider and your own API key; Orbit gives the model a controlled set of tools for
reading, searching, editing and running things inside a directory you explicitly
authorize.

```
 ██████╗ ██████╗ ██████╗ ██╗████████╗     █████╗ ██╗
██╔═══██╗██╔══██╗██╔══██╗██║╚══██╔══╝    ██╔══██╗██║
██║   ██║██████╔╝██████╔╝██║   ██║       ███████║██║
██║   ██║██╔══██╗██╔══██╗██║   ██║       ██╔══██║██║
╚██████╔╝██║  ██║██████╔╝██║   ██║       ██║  ██║██║
 ╚═════╝ ╚═╝  ╚═╝╚═════╝ ╚═╝   ╚═╝       ╚═╝  ╚═╝╚═╝
  ·  ∘  ○  ●  ○  ∘  ·
```

*by -Ksav_Ydv*

```
Your workspace.  Your files.  Your model.  Your API key.  Your agent.
```

---

## Install

Requires Node.js 20 or newer.

```bash
npm install
npm run build
npm link          # optional: puts `orbit` on your PATH
```

Or run it straight from the source tree:

```bash
npm run dev -- ./my-project
```

## Quick start

```bash
cd my-project
orbit
```

On first launch Orbit walks you through picking a provider, entering a key, and
choosing a model. After that:

```
› Analyze this project and find the authentication problem.
```

Orbit inspects the workspace, searches, reads the files it needs, and proposes
changes. Anything that writes, deletes or runs a command asks you first.

## Providers

Orbit is not tied to one vendor. Built-in presets:

| Provider              | Dialect            | Notes                                    |
| --------------------- | ------------------ | ---------------------------------------- |
| OpenAI                | chat-completions   | `OPENAI_API_KEY`                         |
| OpenRouter            | chat-completions   | `OPENROUTER_API_KEY`, hundreds of models |
| DeepSeek              | chat-completions   | `DEEPSEEK_API_KEY`, streams reasoning    |
| NVIDIA NIM            | chat-completions   | `NVIDIA_API_KEY`                         |
| Anthropic             | Messages API       | `ANTHROPIC_API_KEY`                      |
| Google Gemini         | generateContent    | `GEMINI_API_KEY`                         |
| Ollama                | chat-completions   | local, no key required                   |
| Custom                | chat-completions   | any OpenAI-compatible base URL           |

Any endpoint that implements `POST /v1/chat/completions` works — vLLM, LM Studio,
llama.cpp servers, internal gateways:

```bash
orbit provider add        # choose "Custom OpenAI-compatible"
```

Keys are read from the matching environment variable first, otherwise from
`~/.orbit/credentials/providers.json` (written `0600`). They are never printed,
never logged, and never written into a session file.

## Commands

```bash
orbit                      # start in the current directory
orbit ./project            # start in a specific workspace
orbit --model gpt-5        # override the model for one run
orbit --provider deepseek  # override the provider for one run
orbit -p "run the tests"   # send an opening prompt
orbit --auto               # start with auto-working mode on
orbit --theme ember        # pick a palette
orbit --no-animation       # skip the animated intro
orbit --no-optimize        # disable adaptive token budgeting
orbit --debug              # write a redacted log to ~/.orbit/logs

orbit config               # settings screen (loops until you exit)
orbit provider list|add|key [id]|use <id>|remove <id>
orbit model [list|use <model>|context <tokens>]
orbit web [key|on|off]     # Tavily key for web search
orbit mcp list|add <id> <command…>|remove <id>|test [id]
orbit sessions             # list saved sessions
orbit resume [<id>]        # resume the latest, or a specific session
orbit clear                # delete stored sessions
```

### Headless

```bash
orbit --print -p "why is the auth test failing?"
orbit --print -p "fix the lint errors" --yes --output json
git diff | orbit --print -p "review this diff" --output text
```

`--print` runs one prompt with no UI and exits: `0` on success, `1` on error,
`2` if the turn stopped early. `--output json` emits the answer, the tools that
ran, anything that was denied, and token usage — enough to drive Orbit from a
git hook or a CI step. Since nobody can answer a prompt there, permissions are
either covered by `--yes` (the auto-mode envelope) or denied, and the model is
told which.

## In the session

Slash commands:

```
/help          /model         /provider      /status
/context       /compact       /usage         /auto
/undo          /rewind        /checkpoints   /export
/files         /tools         /permissions   /git
/web           /mcp           /bg            /workspace
/theme         /session       /clear         /quit
```

Plus any project commands in `.orbit/commands/`.

### Changing the model, provider or key

The fastest route is mid-conversation — no restart, the context is kept:

```
› /model            # picker: ↑↓ to move, type to filter, enter to choose
› /provider         # picker, showing each provider's model and key status
› /key              # set the API key with hidden input
```

`/model` fetches the live list from the provider and falls back to the saved one
if it is unreachable. For long lists (OpenRouter has hundreds) just start typing
to narrow it. You can still pass a name directly — `/model gpt-5` — or print the
plain list with `/model list`.

From the shell:

```bash
orbit model use gpt-5        # or just: orbit model gpt-5
orbit provider use deepseek
orbit provider key           # change the key for the active provider
orbit config                 # menu: provider, model, key, permissions, …
```

An environment variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) takes
precedence over the stored key. Orbit says so rather than letting a stored-key
change silently do nothing.

Keyboard:

| Key            | Action                                         |
| -------------- | ---------------------------------------------- |
| `Enter`        | Send                                           |
| `Shift+Enter`  | New line (or end a line with `\`, or `Ctrl+J`)  |
| `Ctrl+C`       | Cancel the current generation or command       |
| `Ctrl+D`       | Exit                                           |
| `Ctrl+L`       | Clear the screen                               |
| `Ctrl+O`       | Expand the last truncated tool output          |
| `Ctrl+Shift+A` | Toggle auto-working mode (`Ctrl+G` always works) |
| `↑` / `↓`      | Prompt history                                 |
| `Tab`          | Complete slash commands and file paths         |
| `Esc`          | Clear the input                                |

`Ctrl+C` never kills Orbit mid-task: it cancels the in-flight model stream, tool
or shell command. Press it twice at an idle prompt to exit.

> Most terminals cannot distinguish `Ctrl+Shift+A` from `Ctrl+A` — they send the
> same byte. Orbit binds both the modifier-aware form (Windows Terminal, kitty,
> iTerm with `modifyOtherKeys`) and `Ctrl+G`, which works everywhere. `/auto`
> does the same thing if you prefer typing it.

## The launch animation

On a real terminal the wordmark wipes in column by column, a highlight sweeps
across it once, and a satellite orbits underneath — then it settles and the
prompt appears. It takes about two seconds and **any keypress skips it**.

It is off automatically when it would be noise rather than polish: when stdout
is not a TTY, in `--print` mode, or with `ORBIT_NO_ANIMATION` set. Turn it off
permanently with `--no-animation` or `ui.animation: false` in the config.

The scrollback always ends up with exactly one static banner frame, animated or
not, so piping Orbit's output never captures animation steps.

## Auto-working mode

Off by default. When you turn it on, Orbit does two things:

1. **Approves inside a declared envelope.** Reads, searches, writes and shell
   commands run without prompting. Deletions and secret-looking files still stop
   and ask, and the shell block list still applies.
2. **Keeps going on its own.** When the model's own plan (from `update_plan`)
   still has open steps, Orbit continues without waiting for you — bounded by
   `maxContinuations`, announced each time, and stopped instantly by `Ctrl+C`.

```
› /auto status

Auto mode — on
  Auto-approves     read, search, write, shell
  Always asks       delete, secrets, network
  Self-continues    1/4 used this turn
```

Auto mode widens *approval*. It never widens the workspace boundary, never
enables network access, and never bypasses the command block list. Tune the
envelope in `orbit config → Auto-working mode`.

## Token usage and auto-optimization

Orbit measures what each request actually consumes and produces, then sizes the
next one to the window that is left:

- the reply budget (`max_tokens`) is derived from the peak and average completion
  it has observed, floored and capped by your settings;
- tool output and file-read limits tighten as context pressure rises — and
  **widen on a large-context model**, so a 1M-token window is used rather than
  held to a 32k model's limits;
- when even the minimum reply would not fit, it compacts first rather than
  letting the provider reject the request;
- the stable prefix (system prompt + tool schemas) is marked for **prompt
  caching** where the provider supports it, and cache hits show up in `/usage`.

### Context windows

Orbit detects the window from the model name, and prefers what the provider
reports from its model list. When neither is right — a large-context deployment,
a self-hosted build — set it explicitly:

```bash
orbit model context 1000000     # this model really does have a 1M window
orbit model context auto        # go back to detection
```

The optimizer scales to whatever you set. If the provider then rejects requests
as too long, the number was wrong: lower it.

> Orbit ships each preset with the window its provider documents (DeepSeek's is
> 128K). It will not claim a larger one on your behalf — a wrong number here
> means rejected requests, not a bigger budget.

```
› /usage

Token usage
  Session in      12.4k
  Session out     3.1k
  Requests        9
  Avg reply       344 tokens
  Lifetime in     1.2M

Auto-optimization
  Enabled           yes
  Context in use    31k / 262k (12%)
  Pressure          low
  Reply budget      2.0k tokens (ceiling 16.4k)
```

Lifetime totals are kept per model in `~/.orbit/usage.json` (counts only, never
content) and are shown in `orbit config`, where they can also be cleared. Turn
the whole thing off with `--no-optimize` or in the config screen.

## Tools

| Group      | Tools                                                            |
| ---------- | ---------------------------------------------------------------- |
| Filesystem | `list_files` `read_file` `write_file` `edit_file` `delete_file` `move_file` |
| Search     | `search_files` (ripgrep, with a built-in fallback) `find_files`   |
| Code       | `find_symbol` `outline_file`                                      |
| Terminal   | `execute_command` `run_background` `check_background` `stop_background` |
| Git        | `git_status` `git_diff` `git_log` `git_branch`                    |
| Web        | `web_search` `web_fetch` (Tavily; only with a key)                |
| Documents  | `read_pdf` `read_image`                                           |
| Project    | `inspect_project` `project_structure`                             |
| Agent      | `update_plan` `task`                                              |
| MCP        | `mcp__<server>__<tool>` for every connected server                |

Models without native function calling drive the same tools through a text
protocol. Orbit *parses* those blocks and validates them against the tool schema —
model output is never executed as raw shell text.

**`find_symbol`** matches declarations, not mentions, so "where is `authenticate`
defined?" returns one line instead of forty. It is a lexical index across
TypeScript, JavaScript, Python, Rust, Go, Java, Ruby, PHP and C# — no language
server, no build step.

**`task`** delegates a self-contained investigation to a sub-agent with its own
context window. Only its written report comes back; the tool output it gathered
is discarded with its context. Read-only by default.

**`run_background`** starts a dev server or watcher that outlives the tool call,
so the agent can check its output later instead of blocking a turn on it.
Everything Orbit starts is stopped when Orbit exits.

## Undo

Every file the agent touches is snapshotted before the change, keyed to the turn:

```
› /checkpoints

  turn  when       changes                  prompt
     1  4m ago     2 modified, 1 created    refactor the auth middleware
     2  1m ago     1 modified               fix the failing test

› /undo
Undid turn 2 — fix the failing test
  restored  src/session.ts
```

`/undo` reverts the last turn, `/rewind <turn>` goes further back. Content is
stored by hash in `~/.orbit/checkpoints`, so repeated edits to the same file are
cheap, and the history survives a restart and a `orbit resume`. This is not git:
it never touches your index, your stash or your branches, and it works in a
directory that is not a repository at all.

Orbit also refuses to overwrite a file that **changed on disk after it read it** —
usually because you edited it in your editor mid-turn. It tells the model to
re-read and re-apply rather than clobbering your work.

## Web access

```bash
orbit web key      # hidden input, stored 0600 in ~/.orbit/credentials
```

Adds `web_search` and `web_fetch`, backed by [Tavily](https://tavily.com). Both
sit behind the `network` permission, which is `ask` by default. Only your query
text leaves the machine; the key travels in an `Authorization` header, never in a
logged body. Search results are labelled as results, not facts — the tool tells
the model to open a page with `web_fetch` before treating anything as
authoritative.

Set `TAVILY_API_KEY` and Orbit will use that instead of the stored key.

## MCP servers

```bash
orbit mcp add fs npx -y @modelcontextprotocol/server-filesystem /path
orbit mcp test fs      # start it, list its tools, shut it down
```

Every tool an MCP server exposes becomes `mcp__<server>__<tool>` and goes through
the same approval path as anything else. Because MCP servers reach outside the
workspace by design, they are all classified as `network` operations and always
ask. A server that fails to start is reported and skipped; the session continues
without it.

## Project commands

A file at `.orbit/commands/review.md` becomes `/review`:

```markdown
---
description: Review the working tree for correctness bugs
---
Review the current diff for correctness problems. Focus on $ARGUMENTS.
Report each finding with a file:line reference.
```

`$ARGUMENTS`, `$1`, `$2`… are substituted; with no placeholder, arguments are
appended. A project command can never shadow a built-in one.

## Safety model

**Workspace boundary.** Every path is resolved against the workspace root.
`../../.ssh/`, absolute paths and symlinks that point outside are rejected, not
silently followed.

**Permissions.** Five classes, each `allow` / `ask` / `deny`:

```
Read      allowed      Write     ask
Search    allowed      Delete    ask
                       Shell     ask
                       Network   ask
```

Approval prompts show what will actually happen — a unified diff for a file
change, the exact command line for a shell call. "Allow for session" is scoped to
that file or that program, and is never offered for destructive operations.

**Secrets.** `.env`, `*.pem`, `id_rsa`, credential stores and similar files are
recognised. Reading one prompts for confirmation even when reads are otherwise
allowed, and secret-shaped values are redacted from logs and from the UI.

**Honesty.** Orbit never fabricates tool results. When the transcript says
`● execute_command / npm test`, that command ran; the output shown is the output
captured. When a model cannot accept images, Orbit says so rather than pretending
to have looked.

## Architecture

```
            ┌──────────────────────┐
            │      ORBIT CLI       │   Ink + React
            └──────────┬───────────┘
            ┌──────────▼───────────┐
            │    Agent Runtime     │   loop · planner · context · sessions
            └──────────┬───────────┘
     ┌─────────────────┼─────────────────┐
     ▼                 ▼                 ▼
 Provider Layer   Tool Registry   Permission Layer
 OpenAI-compat    fs · search     policy · prompts
 Anthropic        shell · git     sandbox
 Gemini           pdf · image
```

```
src/
├── index.ts          CLI entry, subcommands, startup
├── cli/              Ink app, slash commands, input, keyboard, setup, headless
├── ui/               themes + presentational components
├── agent/            agent, loop, planner, prompts, auto mode, sub-agents
├── providers/        provider interface + adapters
├── tools/            tool registry and implementations
├── mcp/              MCP stdio client and tool adapter
├── checkpoints/      per-turn snapshots and restore
├── permissions/      policy manager and workspace sandbox
├── context/          token budgeting, compaction, usage, optimizer
├── sessions/         session persistence
└── config/           schema and config/credential manager
```

The agent runtime never imports a concrete provider, and the tools never import
the UI. Each layer can be replaced independently.

**Context management.** Orbit estimates the token budget, compresses old tool
results first (cheap and near-lossless), and only then summarises earlier turns —
never splitting a tool call from its result.

**Project instructions.** If the workspace contains `ORBIT.md` (or `AGENTS.md`),
its contents are added to the system prompt.

## Configuration

```
~/.orbit/
├── config.json              providers, permissions, agent, optimizer, auto mode,
│                            web, MCP servers, checkpoints, theme, pricing
├── credentials/             API keys and the Tavily key, 0600
├── sessions/                saved conversations (never any keys)
├── checkpoints/             per-turn file snapshots for /undo, content-addressed
├── usage.json               token counts per model (counts only, no content)
├── cache/
└── logs/                    only written with --debug, redacted
```

## Development

```bash
npm run dev        # run from source
npm run build      # compile to dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

The suite covers the sandbox boundary, the permission system, every tool against
a real temporary workspace, provider streaming against a mock OpenAI-compatible
server, context compaction, adaptive token budgeting, auto-working mode, the
terminal UI (driven by simulated keystrokes), and two end-to-end acceptance flows
that build a project, run its tests, find a real bug and verify the fix.

## Known limitations

- OCR for scanned PDFs is not bundled. Orbit reports when a PDF has no text layer
  instead of guessing at its contents.
- MCP support is stdio transport only, and covers tools — not resources or
  prompts.
- `find_symbol` is a lexical index, not a parser. It finds declarations reliably
  in the languages listed above and nothing at all in the ones it does not know.
- Cost estimates need rates you enter yourself. Orbit ships no price table.
- Checkpoints cover files the agent's tools touched. Changes made by a shell
  command it ran are not snapshotted — `git` remains the safety net for those.

## License

MIT
