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

## Platform support

Orbit runs on **Windows, macOS and Linux** from one codebase. Everything
platform-specific — process spawning, path handling, line endings, terminal
capabilities — is branched explicitly and covered by `tests/platform.test.ts`.

| | Requirement |
| --- | --- |
| **Runtime** | Node.js 20 or newer (22 LTS recommended) |
| **Windows** | Windows 10/11. Windows Terminal or VS Code's terminal is recommended — the legacy `conhost` console lacks UTF-8 and colour support, and Orbit falls back to ASCII automatically there. Works in PowerShell, cmd.exe and Git Bash. |
| **macOS** | 12 or newer, Intel or Apple Silicon. Terminal.app, iTerm2 and the VS Code terminal all work. |
| **Linux** | Any distribution with Node 20+. Works over SSH and inside containers. |
| **Optional** | `git` for the git tools, `ripgrep` (`rg`) for faster search. Orbit degrades gracefully without either. |

What Orbit handles for you:

- **Line endings.** A CRLF file stays CRLF after an edit; an LF file stays LF.
  The model never sees stray carriage returns.
- **Path separators.** On Windows you can type `src/index.ts` or the backslash
  form; paths shown to you and to the model are always forward-slashed.
- **Case sensitivity.** The workspace boundary is case-insensitive on Windows
  and case-sensitive on POSIX, matching each filesystem.
- **Command shims.** On Windows, tools installed as `.cmd`/`.bat` (`npx`, `rg`,
  many CLIs) are launched through `cmd.exe` — Node cannot execute them directly.
- **Process trees.** Cancelling a command kills the whole tree: `taskkill /T` on
  Windows, `SIGTERM` then `SIGKILL` on POSIX.
- **Terminal capability.** Colour, Unicode and animation are each detected and
  degrade independently, so Orbit stays readable over SSH, in CI and in a pipe.

## Install

```bash
npm install
npm run build
npm link          # RECOMMENDED TO ADD : put `orbit` on your PATH
```

Or run it straight from the source tree:

```bash
npm run dev -- ./my-project
```

<details>
<summary>Platform notes</summary>

**Windows.** If glyphs look wrong, use Windows Terminal, or force the ASCII
symbol set with `--ascii` (or `ORBIT_ASCII=1`). Orbit stores state in
`%USERPROFILE%\.orbit`. File modes are set where the filesystem supports them;
NTFS ignores POSIX permission bits, so protect that folder with ACLs if you
share the machine.

**macOS / Linux.** State lives in `~/.orbit`, with credentials written `0600`
and the credentials directory `0700`.

**Containers and CI.** Orbit detects a non-TTY and turns off the animation and
colour by itself. Use `--print` for scripted runs; see [Headless](#headless).

</details>

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

### Long sessions keep what you told them

When the conversation outgrows the window, Orbit compacts it: old tool output is
shrunk first, then older turns are folded into a written summary. A summary
records what *happened* — it does not reliably carry forward what it was *told*.
"Never touch anything under `generated/`", said once at the start, is exactly the
kind of standing instruction that gets paraphrased into nothing, and the agent
then breaks it and looks like it forgot.

So your own messages travel through compaction **word-for-word**, alongside the
summary:

```
[Summary of earlier conversation, generated automatically to free context space]

We renamed several modules and fixed the build.

[Your earlier instructions, kept word-for-word. These are still in force
unless something later in this conversation overrides them.]

1. Never touch anything under generated/. It is all machine-written.
2. Use tabs in this repo, not spaces.
```

They are kept newest-first inside `agent.keepInstructionTokens` (1,500 by
default), because a later instruction usually supersedes an earlier one — so if
anything has to be dropped it should be the oldest, and the summary still covers
it. A single enormous paste is quoted in part rather than in full. Set the budget
to 0 to summarise everything instead.

Project-level instructions in `ORBIT.md`, `AGENTS.md` or `CLAUDE.md` live in the
system prompt and were never subject to this — they are always in force.

### A steady terminal while streaming

Ink updates its live region by moving the cursor up and rewriting those lines.
That works only while the region is shorter than the window: once it is taller,
it clears the **whole screen** on every update instead, and the redraw is visible
as flicker. Measured on a 30-row terminal streaming a long reply:

| Live region | Full-screen clears | Terminal writes |
| --- | --- | --- |
| unclipped | 54 | 403 KB |
| clipped to the window | **0** | **42 KB** |

So a streaming reply shows its tail — the part being written — with a count of
what has scrolled past:

```
… 120 earlier lines above
the reply continues here, still being written▌
```

Nothing is lost: the complete text is committed to scrollback the moment the turn
ends. The clip is row-aware rather than line-aware, because a long line wraps and
costs several rows of the window; counting lines would still overflow, and still
flicker.

### What each request costs

Every model request prints what it actually used, from the provider's own
figures rather than an estimate:

```
› refactor the auth middleware

  … Orbit works …

  up 12.4k  ·  down 1.2k  ·  940 thinking  ·  8.2k cached  ·  31k/128k ctx  ·  3.4s
```

`thinking` is the part of the output the model spent reasoning, which reasoning
models bill as output tokens but report separately — so a long think is visible
instead of just expensive. It comes from `completion_tokens_details.reasoning_tokens`
on OpenAI-compatible providers and `thoughtsTokenCount` on Gemini; providers that
do not separate it simply do not show the figure.

While a model is still thinking, the live counter beside the trace is Orbit's own
estimate of the text so far and is marked `~`. The provider's real number
replaces it when the request completes. Turn the whole line off with
`ui.requestCost: false`.

`/usage` totals it per session and lifetime, including the thinking share.

### Thinking shares the output budget

Reasoning is billed as completion tokens, so thinking and the answer draw on the
same `max_tokens`. That creates a trap worth knowing about: a model granted 1.4k
can spend all 1.4k reasoning and write nothing, and the turn ends looking like a
refusal.

Three things prevent it:

- **The budget is sized for thinking plus answer.** Observed reasoning sets a
  floor of roughly twice what the model actually thinks, and
  `optimizer.reasoningHeadroom` (8k default) is added on top. A model that does
  not reason gets none of this padding.
- **A truncated reply is not treated as evidence of reply length.** It is
  evidence of the cap, so the next grant doubles instead of creeping up 35% at a
  time and truncating forever.
- **A request that produced only thinking is retried, wider.** Up to
  `optimizer.maxOutputLimitRetries` times (2 by default), rather than handing
  back an empty turn for you to prod with "continue":

```
Output limit reached at 1.4k tokens with nothing but thinking to show.
Retrying with 5.5k.
```

A reply that was cut off mid-sentence is **kept**, not retried — it has content
worth having, and re-asking would discard work you already paid for. Only a reply
with nothing usable in it is worth asking again.

### Real prices, where the provider publishes them

Orbit still ships no rate table — prices change, and a stale number is worse
than none. What it can do is ask:

```bash
orbit pricing import                            # from what the provider publishes
orbit pricing set "DeepSeek:deepseek-chat" 0.27 1.10
orbit pricing                                   # what is in force
```

OpenRouter publishes machine-readable per-token prices, so `import` fills them in
exactly. A model listed under two vendors at different prices is **left
unpriced** rather than guessed at. A provider on a local address that publishes
nothing is priced at zero — but only after being asked, so a paid API behind a
localhost proxy is not silently free.

Thinking tokens are billed as output, and are counted there.

### Context windows

The window drives every budget in a session, so Orbit **asks the provider** what
it is rather than guessing from the model name. Detection runs in the background
at launch, overlapping with the rest of startup, and is cached per model — so it
costs at most one request the first time you use a model, and nothing after that.

Sources, in order of authority:

| Source | How Orbit gets it |
| ------ | ----------------- |
| **You** | `orbit model context <n>`. Never overridden by anything below. |
| **Reported** | the provider's own model list says so — OpenRouter's `context_length`, Gemini's `inputTokenLimit`, vLLM's `max_model_len`. |
| **Probed** | the provider names its limit when refusing an impossible completion length. Rejected during validation, so no tokens are generated. |
| **Preset** | the built-in preset, when the model name implies nothing more specific. |
| **Name** | inferred from the model name. A guess, and labelled as one. |

Whichever applies, the banner and `orbit model context` tell you which:

```
› orbit model context

  Model           deepseek-v4-pro
  Context window  1,000,000 tokens  (reported by DeepSeek)
```

```bash
orbit model context             # what is in force, and where it came from
orbit model context up          # one step larger
orbit model context down        # one step smaller
orbit model context +50k        # relative to the current window
orbit model context 1m          # an exact size (1000000 and 128k also work)
orbit model context detect      # ask the provider again (a model was resized)
orbit model context auto        # drop the override, go back to detection
```

`up` and `down` walk a ladder of the sizes models actually ship with — 8k, 16k,
32k, 64k, 128k, 200k, 256k, 400k, 512k, 1M — so a step always lands somewhere
plausible. An off-ladder size snaps in the direction you asked for, never past
it. `orbit config → Context window` is the same thing as a menu, with the
resulting size previewed on each option, and it loops so three steps up is three
keypresses.

Inside a session, `/context` on its own shows the usage breakdown, and takes the
same arguments to resize live:

```
› /context up
Context window increased: 128k → 131k. 118k free for this turn.
```

A resize that would shrink the window below what the conversation already
occupies is refused — the next request would be rejected by the provider
otherwise. `/compact` first, or pick a larger size.

A window discovered after the banner has scrolled past is applied to the live
session and announced in the transcript — the reply reserve, tool-output limits
and compaction threshold are all recomputed from the new size, so switching from
a 32k model to a 1M one actually gets you the room.

Detection can be turned off in `orbit config` (`optimizer.autoDetectWindow`), and
the probe specifically with `optimizer.probeWindow` if you want startup to make
zero extra requests. The cache lives at `~/.orbit/cache/context-windows.json` and
is safe to delete.

> Orbit will not claim a window on your provider's behalf. If a provider stays
> silent, Orbit says so and falls back to a documented figure — a number that is
> too large here means rejected requests, not a bigger budget.

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

## When a provider will not answer

Eight providers configurable and no fallback meant one rate limit ended the
turn. Now it can ask someone else:

```bash
orbit failover add openrouter    # try this if the active provider fails
orbit failover                   # show the chain and what triggers it
orbit failover off
```

A switch happens **mid-turn**, keeping every message and tool result already
gathered, and is announced in the transcript — which model wrote the rest of an
answer is not something to change quietly. Usage and cost are attributed to
whoever actually answered.

| Triggers a switch | Does not |
| --- | --- |
| `429` rate limit | `400` — the request is at fault and would be rejected everywhere |
| `402` no credit | a tool schema the model got wrong |
| `5xx` server trouble | a prompt over the window |
| auth and network failures (opt in) | anything the model itself did |

Each provider is tried at most once per turn, candidates with no key are skipped,
and by default the next turn goes back to the primary rather than quietly
settling on the fallback.

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

## The shell remembers

`cd` and exported variables carry from one command to the next:

```
$ cd packages/api
$ pwd
/home/me/project/packages/api      ← not the workspace root
$ export NODE_ENV=test
$ echo $NODE_ENV
test
```

Each command still runs in its own process — only the resulting directory and
environment persist — so exit codes, timeouts and cancellation are exactly as
before. A long-lived interactive shell would be the other approach, and would
mean parsing prompts to guess where one command's output ends, which is not
something to build a timeout on.

A command that leaves the workspace does **not** take the session with it: `cd /`
runs, and the next command is still inside the sandbox. Only variables that
differ from Orbit's own environment are carried, so the set stays small and
inspectable. Turn it off with `tools.persistentShell: false`.

## Finding things

`find_symbol` and `outline_file` **parse** the file rather than scanning it, for
the 26 extensions covered by a bundled grammar — TypeScript, TSX, JavaScript,
Python, Rust, Go, Java, C#, C/C++, Ruby, PHP, Bash, CSS, PowerShell.

That means a declaration inside a block comment or a template string is not a
declaration, `private` really means private, and Go's capital letter and Python's
leading underscore are read the way each language means them:

```
› /help find_symbol

  src/auth.ts:12  [function, exported] signIn
      export function signIn(user: string) {

  2 declarations of "signIn" (searched 148 files, parsed)
```

The grammars are pre-built WASM, so there is no native compilation and an install
behaves the same on Windows, macOS and Linux. They are also ~22 MB, so they are
an **optional dependency**: if the bundle is missing, everything falls back to
the line scan and the output says `matched by pattern` instead of `parsed`. A
language with no grammar takes the same path.

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
cheap, and the history survives a restart and a `orbit resume`. It never touches
your index, your stash or your branches.

### Shell commands are covered too

Orbit's file tools say what they are about to change, so their previous contents
can be saved one file at a time. A shell command can change anything, and there
is no way to know what in advance — so the whole working tree is captured before
and after it runs, and whatever moved is recorded.

That uses git as a fast content store: the tree is written to a git tree object,
which reuses blobs git already has and honours `.gitignore`, so `node_modules`
and build output are never snapshotted. Your index, stash and branches are
untouched — the temporary index is a throwaway copy, and the objects written are
unreferenced, so they never appear in `git status` or `git log` and `git gc`
prunes them.

```
› run the codegen script

  $ npm run codegen
  14 files changed — /undo can revert

› /undo
Undid turn 3 — run the codegen script
  restored  14 files
```

Files a command *created* are deleted on undo; files it deleted are restored.
A command that timed out or was cancelled still gets its partial writes
recorded, because those need undoing most.

Two caveats, both deliberate:

- **It needs a git work tree.** In a plain directory, shell commands are not
  covered — Orbit's own file tools still are. There is no way to reconstruct the
  previous contents of a file nothing had a copy of.
- **It costs roughly 100ms per shell command** (two snapshots), scaling with the
  number of tracked files rather than the repo's size on disk. Turn it off with
  `checkpoints.shellCommands: false` in the config, or in
  `orbit config → Checkpoints and undo`.

A single command that rewrites more than 400 files records the first 400 and logs
that it stopped, rather than turning one undo into a multi-gigabyte snapshot.

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

## Checking its own work

Orbit can run your project's real checks after a turn that changed files, hand
itself the failures, and fix them — before giving the turn back to you:

```
› add retry logic to the client

  ✎ edited src/client.ts
  Verifying: npm run typecheck
  Verifying: npm run test
  ✗ 2 failing: timeout not cleared on retry
  ✎ edited src/client.ts
  Verified after 2 rounds: typecheck, test passed in 6.4s.
```

```bash
orbit verify        # what it would run here, and whether it is on
orbit verify on
```

The evidence is real command output, not the model's opinion of its own work.
The checks come from your project — a `typecheck`, `build` or `test` script, or
`cargo check`, `go test`, `pytest` — with the cheapest useful signal first,
because a type error is found in seconds and makes a test run pointless anyway.
A dev server or a deploy script is never run unprompted. Name your own with
`verify.commands`.

Three things keep it from becoming a token sink:

- **It stops at the first failure.** Once the type-check is red, the test output
  is noise rather than information.
- **It stops when it stops making progress.** Identical failures two rounds
  running mean the last attempt changed nothing that mattered, so another round
  would spend a request to reach the same place. Line numbers are ignored when
  comparing — shifting by one is not progress.
- **A missing check is not a failure.** If the command is not installed, the
  shell says so, and Orbit reports that nothing was verified rather than asking
  the model to fix a binary it cannot install — which would invite it to edit
  the check instead.

Off by default: it runs commands on your machine and spends tokens doing it.
`verify.rollbackOnFailure` additionally undoes the turn when the checks never
pass, leaving the workspace as it was rather than half-fixed.

## Keystrokes typed a moment too early

Ink dispatches input through an event emitter with no replay, and a handler
subscribes in an effect — which runs *after* the frame announcing the prompt is
already on screen. So there is a window where the prompt is visible, the
previous handler has unsubscribed, and the new one has not yet subscribed.
Anything typed then went to nobody. You saw a prompt that ignored you.

Orbit now watches stdin for the whole session and hands anything caught in that
window to the handler that appears next. Keystrokes older than half a second are
dropped rather than replayed — by then you have seen the prompt and will type
again, and a key arriving from nowhere is worse than one that was missed.

**A replayed keystroke can never approve anything.** Into an approval prompt,
only a denial or a cancel is replayed; `y` and `a` are ignored and must be typed
live. Replaying a buffered approval would authorise an operation you never read,
which is the one thing the permission system exists to prevent.

## What it remembers about you

Corrections are kept and applied in later sessions. Two things trigger one:
rejecting an operation and saying what you wanted instead, and simply telling
Orbit a rule in passing — "no, never edit the lockfile by hand", "from now on
prefer async/await". The second is how a rule usually arrives.

The test is narrow on purpose: the message has to generalise. "No, fix that typo
on line 4" is about this moment and is not kept; capturing everything corrective
would fill the prompt with noise, which is worse than capturing nothing.

```
› /lessons

  1. Use make deploy, never npm publish      (from a correction)
  2. Tabs, not spaces, in this repo
```

```bash
orbit lessons                  # what it remembers here
orbit lessons add "<text>"
orbit lessons forget 2
```

Kept **per workspace**, because advice about one repository is usually wrong
about another, and stored under `~/.orbit` rather than written into your
project. Repeating a lesson folds into the existing entry instead of stacking
up, and the newest survive the 50-entry cap. They go into the system prompt as
context you *can* override — the live conversation always wins, and Orbit is
told to say so if one conflicts with what you are asking now.

Turn it off with `agent.rememberLessons: false`.

## When Orbit edits Orbit

Working on the source of the program that is running is the one case where a
broken change is not merely inconvenient: the next launch may not start, and the
tool you would use to fix it is the tool that is broken.

So when the workspace is Orbit itself — recognised by its package name, so a
clone or fork under any path counts — verification and rollback default to
**on**. A setting you chose yourself is never overridden; this only fills in the
safer default where you never said.

## Lifecycle hooks

Hooks are shell commands Orbit runs when something happens: a file is written, a
turn finishes, a session starts. They turn Orbit from a thing that edits code
into a thing that edits code *and then formats it, and runs the tests*.

They live under `hooks` in `~/.orbit/config.json`:

```json
{
  "hooks": {
    "enabled": true,
    "entries": [
      {
        "name": "format",
        "on": "post-tool",
        "tools": ["write_file", "edit_file"],
        "command": "npx prettier --write \"$ORBIT_FILE\""
      },
      {
        "name": "test",
        "on": "turn-end",
        "command": "npm test",
        "showOutput": true
      },
      {
        "name": "protect-secrets",
        "on": "pre-tool",
        "tools": ["/^(write|edit|delete)_/"],
        "command": "sh -c 'case \"$ORBIT_FILE\" in *.env*) exit 1 ;; esac'",
        "blocking": true
      }
    ]
  }
}
```

| Event | When |
| ----- | ---- |
| `session-start` | once, after the workspace and model are ready |
| `session-end` | once, on exit — interactive and `--print` alike |
| `turn-start` | you submitted a prompt |
| `turn-end` | the agent stopped working on it |
| `pre-tool` | before a tool runs. With `blocking`, a non-zero exit **refuses the call** |
| `post-tool` | after a tool ran, before the model sees the result |

`tools` filters the tool events: a bare string matches exactly, `/pattern/` is a
regular expression. An empty list matches every tool.

Each hook is handed the details twice — as environment variables for one-liners,
and as JSON on stdin for scripts:

| Variable | |
| -------- | - |
| `ORBIT_EVENT` | the event name |
| `ORBIT_WORKSPACE` | the workspace root (also the hook's working directory) |
| `ORBIT_FILE` / `ORBIT_FILE_RELATIVE` | the path the tool is acting on, when there is exactly one |
| `ORBIT_TOOL` / `ORBIT_TOOL_ARGS` | the tool name, and its arguments as JSON |
| `ORBIT_TOOL_OK` | `1` or `0`, on `post-tool` |
| `ORBIT_MODEL` / `ORBIT_PROVIDER` / `ORBIT_SESSION` | the session's identity |
| `ORBIT_TURN` / `ORBIT_TURN_REASON` | turn number, and how the turn ended |

```bash
orbit hooks              # list them, with their filters and flags
orbit hooks test 2       # run one now and show what it did
orbit hooks test 2 write_file   # …against a specific tool name
```

`/hooks` shows the same list inside a session.

Hooks for one event run **in order, one at a time** — two formatters racing on
the same file is not a bug anyone can debug. Each is bounded by `timeoutMs`
(60s default), its output is capped and redacted, and a hook that fails is
reported without taking the turn down with it. The one exception is a `blocking`
`pre-tool` hook: its non-zero exit is the whole point.

> **Hooks are read from your user config only — never from anything inside a
> workspace.** A hook is arbitrary code, so cloning a repository and opening it
> in Orbit must not be able to run anything. There is deliberately no
> `orbit hooks add`: a command Orbit will execute on your behalf belongs in a
> file you edited on purpose.

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

## Accepting part of a change

A model that gets four things right and one thing wrong used to force an
all-or-nothing decision. Press **P** at the approval prompt to review the change
hunk by hunk:

```
  Edit src/auth.ts
  Change      +18 −6

  → [x] line 12  +4 -1   const token = await refresh(session)
    [ ] line 88  +14 -5  export function retryForever(fn) {

  space toggle · ↑↓ move · a all/none · enter apply 1 of 2 · esc back
```

The file is rebuilt from the hunks you kept, and the model is told plainly that
the rest were rejected so it does not assume they landed. If the chosen hunks
cannot be applied on their own — they overlap — the call is **refused** rather
than half-applied: a file that is neither what the model proposed nor what you
picked is the worst available outcome.

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

### A broken config file does not lock you out

One typo used to fail the whole load — including `orbit config`, which is what
the error told you to run. Now each section is validated on its own:

```
Parts of ~/.orbit/config.json could not be used:
  hooks.entries[1] — command: Required
  providers.staging — baseURL: Invalid url
  Those sections are running on defaults. Everything else loaded normally.
  Fix the file, or run: orbit config
```

Two collections get finer treatment still, because they are lists you curate by
hand: one bad hook does not discard the others, and one bad provider does not
take the rest with it. Before anything overwrites the file, the original is
copied to `config.json.invalid-<timestamp>` so a nearly-right section is never
lost. Unparseable JSON is the one case with nothing to salvage — there is no way
to guess what was meant.

## Environment variables

| Variable | Effect |
| --- | --- |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `GEMINI_API_KEY` | Provider key; takes precedence over the stored one |
| `TAVILY_API_KEY` | Web search key |
| `ORBIT_HOME` | Move Orbit's state directory (default `~/.orbit`) |
| `ORBIT_ASCII=1` | Force the ASCII symbol set |
| `ORBIT_NO_ANIMATION=1` | Skip the launch animation |
| `NO_COLOR`, `FORCE_COLOR` | Standard colour control, honoured on every platform |

## Development

```bash
npm run dev        # run from source
npm run build      # compile to dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

The suite covers the sandbox boundary, the permission system, every tool against
a real temporary workspace, provider streaming against a mock OpenAI-compatible
server, context compaction, adaptive token budgeting, auto-working mode,
checkpoints and undo, MCP against a real stdio server, the terminal UI driven by
simulated keystrokes, and two end-to-end acceptance flows that build a project,
run its tests, find a real bug and verify the fix.

`tests/platform.test.ts` covers the platform-specific branches: path separators
and case sensitivity, CRLF/LF preservation, Windows `.cmd` shim resolution,
ripgrep output parsing with drive letters, and terminal capability detection.
Tests that only apply to one OS are skipped on the others rather than silently
passing.

> **On verification:** this codebase was built and exercised on Windows, so the
> Windows paths are executed end to end — including launching a real `npx`-based
> MCP server. The macOS and Linux branches are covered by unit tests of the same
> platform-specific functions, but were not executed on those operating systems.
> If you hit a POSIX-specific problem, it is a genuine gap rather than something
> that was checked and dismissed.

### A note on NODE_ENV

Orbit defaults `NODE_ENV` to `production` for its own process when you have not
set it. React chooses between its two builds by reading that variable **at import
time**, and the development build calls `performance.measure()` on every render —
a few hundred entries a second for a live terminal UI. Nothing drains Node's
global user-timing buffer, so an hour-long session used to end in:

```
MaxPerformanceEntryBufferExceededWarning: Possible perf_hooks memory leak
detected. 1000001 measure entries added to the global performance entry buffer.
```

The development build is slower besides. Two things follow:

- **Child processes never see the injected value.** Orbit runs your tests, your
  builds and your hooks, and they get the environment you have — not one Orbit
  invented for its own renderer. A `NODE_ENV` you set yourself is passed straight
  through and never overridden.
- **If your shell exports `NODE_ENV=development`**, Orbit honours it and React
  loads the development build regardless. A performance observer then clears the
  entries as they arrive, which keeps the buffer at a handful instead of a
  million.

## Known limitations

- OCR for scanned PDFs is not bundled. Orbit reports when a PDF has no text layer
  instead of guessing at its contents.
- MCP support is stdio transport only, and covers tools — not resources or
  prompts.
- `find_symbol` parses the languages it has a grammar for and falls back to a
  line scan for the rest. Every result says which it was, so a scan is never
  mistaken for a parse.
- Cost estimates need rates you enter yourself, except where a provider
  publishes them. Orbit ships no price table.
- Checkpoints cover shell commands only inside a git work tree, since that is
  what makes capturing the whole tree cheap. In a plain directory, only the
  agent's own file tools are undoable.
- Stale-write detection compares modification time and size. On filesystems with
  one-second timestamp granularity (older HFS+), an external edit made in the
  same second *and* of identical size would go unnoticed.
- The legacy Windows console (`conhost`) renders the ASCII fallback rather than
  the block wordmark. Windows Terminal shows the full mark.

## Website

The marketing site lives in [`web/`](web/) — a static React + Vite build deployable
to Vercel or any static host. It is separate from the CLI and shares no code.

```bash
cd web
npm install
npm run dev
```

The repository URL on the site is a placeholder defined once, in
`web/src/config/site.ts`. Change that line before deploying. See
[`web/README.md`](web/README.md) for details.

## License

MIT
