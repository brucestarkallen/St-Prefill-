# Prefill Control

Prefill support for SillyTavern chat completions, including **thinking prefill** — seeding a model's reasoning scratchpad instead of its visible output.

No SillyTavern source file is modified. Nothing to reapply after an update.

---

## What prefill is

A chat completion normally ends with a user turn, and the model starts a fresh assistant turn from nothing. Prefill appends a final **assistant** message and marks it as unfinished, so the model continues *your* text instead of beginning its own.

The flag differs by provider:

| Provider | Continuation flag | Reasoning field |
| --- | --- | --- |
| Moonshot / Kimi (direct) | `partial` | `reasoning_content` |
| OpenRouter → Moonshot provider | `partial` | `reasoning_content` |
| DeepSeek (beta) | `prefix` | `reasoning_content` |
| OpenRouter (generic) | — | `reasoning` |
| Custom / OpenAI-compatible | — | `reasoning_content` |
| Anthropic | native, none needed | — |

On SillyTavern's built-in **Moonshot** and **DeepSeek** sources the server sets
the flag itself, in `addAssistantPrefix()`. Leaving the field empty there costs
nothing. It matters on custom endpoints, OpenRouter, and proxies, where nothing
sets it for you.

**Thinking prefill** is the interesting case. Reasoning models emit two channels: `content` (what you read) and a reasoning channel (the scratchpad). Send a seed in the reasoning channel with `content` left empty and the model **continues the thought** rather than replacing its own reasoning:

```json
{ "role": "assistant", "content": "", "reasoning_content": "I should continue the story.", "partial": true }
```

SillyTavern cannot express that on its own — `ChatCompletion.getChat()` drops messages with empty content, so a pure thinking prefill never survives prompt assembly. This extension performs the split after assembly, where it sticks.

---

## Install

SillyTavern → **Extensions** → **Install extension** → paste:

```
https://github.com/brucestarkallen/St-Prefill-
```

Settings appear under **Extensions → Prefill Control**. It ships **disabled**.

---

## Use

1. Pick a **field mapping** matching your provider. This writes the two field names below it — nothing is inferred from the model name at request time.
2. Choose where the prefill comes from:
   - **Extension** (default) — the text box below is appended as a final assistant message whenever the prompt has no assistant tail. Nothing to edit in the preset, and it is the only way to express a pure thinking prefill.
   - **Preset** — your preset already ends with an assistant message and you want that used verbatim. If it does not, the status line reports *"prompt does not end in an assistant message"* and nothing is sent.
3. Write the seed with the thinking tag first:

   ```
   <think>I should continue the story.
   ```

   Everything after the tag up to `</think>` (or end of string) goes into the reasoning field; the remainder stays in `content`.
4. Enable.

The status line under the toggle reports what happened on the last request — applied, or which guard skipped it and why.

## Check it works

**Run test**, in the settings panel, builds a request shaped like a real one on
your install, puts it through the same engine and the same server-side
post-processing a real request goes through, and prints the final message
exactly as the provider receives it. Nothing is sent anywhere.

It reports both situations separately — a normal chat whose prompt ends with
your message, and a prompt that already ends with an assistant message — because
a configuration can work in one and not the other. Once you have sent at least
one message it models your real source, post-processing and thinking setting
rather than assuming defaults, and says which it is doing.

A verdict of *PREFILLED, BUT … WILL NOT ARRIVE* means the engine did its part
and the server will undo it. That is what the merge guard is for.

## The decision log

The panel at the bottom of the settings holds the last ten requests, newest first, each showing the reason code and **the final message exactly as it goes on the wire**. That is the log. There is no browser console step, which matters on Android and iOS where devtools are not reachable.

**Copy** puts the whole log on the clipboard; if the clipboard is unavailable it selects the text instead. **Clear** empties it. Long fields are truncated so the panel never holds a second copy of the prompt.

Console output is a separate opt-in checkbox for anyone running SillyTavern on a desktop.

---

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Enabled | off | Master switch |
| Field mapping | — | Writes the two fields below; not a runtime behaviour |
| Continuation flag | `partial` | Empty writes no flag |
| Reasoning field | `reasoning_content` | Empty disables the split |
| Prefill comes from | extension | `extension` appends the text box; `preset` uses the preset's own assistant tail |
| Split leading thinking tag | on | Moves the tagged span into the reasoning field |
| Open / close tag | `<think>` / `</think>` | Close tag optional; both are regex-escaped |
| Keep the thinking channel open | on | Turns reasoning on for requests carrying a seed, and only those |
| Apply to Continue | on | Marks the existing partial reply as a continuation |
| Apply to Impersonate | off | Impersonation writes as the user, not the character |
| Apply to utility generations | **off** | See below |
| Skip when tools are in play | on | Providers reject continuation flags alongside tools |
| Skip on JSON schema | on | Same |
| Merge guard | on | See below |
| Also write to browser console | off | Desktop only; the in-app log is always on |

**Reset to defaults** sits at the bottom. It restores every setting above and takes two taps to confirm, so a mis-tap on a phone cannot wipe a working setup. Keys left behind by older versions are dropped. The decision log is history rather than a setting and is left alone — Clear handles that.

### Utility generations

Summaries, keyword extraction, and other extension-driven calls reach the API as `type: 'quiet'`. A story prefill welded onto a summarisation request corrupts the summary. These are excluded by default and the setting exists only so you can opt in deliberately.

Extensions calling `ConnectionManagerRequestService.sendRequest` use a separate code path that never emits the hooked event, so those are untouched regardless of this setting.

### Merge guard

SillyTavern's server-side prompt post-processing merges consecutive same-role messages, and the **earlier** object is the one that survives. A continuation flag written on a later assistant message would be silently discarded whenever the prompt tail happens to be two assistant turns.

With the guard on, the merge is performed here first, so the flag lands on the surviving object and the server's merge becomes a no-op. Turn it off only if you have a reason to want two assistant messages on the wire — with it off, the panel will tell you the prefill is not going to arrive rather than reporting a clean success.

The guard stands down when it cannot reproduce what the server does, and one case reaches that: a previous message carrying an image or audio. The server flattens media to text before it merges, through placeholder tokens it generates itself, so nothing written here can be carried across by hand. The panel reports that too — it is the one merge risk that exists with the guard switched on.

Whether the server merges is **not** the same question as which post-processing you selected. `sendDeepSeekRequest()`, `sendMinimaxRequest()` and the Perplexity branch each run their own post-processing regardless of that setting, so the guard reads the source as well as the setting.

The guard also reproduces the server's name fold before deciding. `mergeMessages()` prepends `Name: ` to a message's content *before* it tests whether to squash it, so a thinking prefill whose content is empty is not empty by the time that test runs.

Post-processing set to **Single user message** collapses the whole prompt into one user turn. Prefill is impossible there; the extension skips and says so rather than writing a flag onto a user message.

---

## Does prefill degrade the model?

Partly, and it depends entirely on which channel you use and how much you write.

**Content prefill degrades.** The text is off-policy — the model did not generate it — and it occupies the opening tokens, which is where the model decides what kind of task it is looking at and what plan to follow. It also locks in style and any claim it contains, because the model treats its own turn as a prior commitment. On a reasoning model, a prefilled `content` can suppress the reasoning pass outright.

**Thinking prefill is much lighter.** With `content` empty, the reasoning budget and the analysis are intact; you have nudged the first sentence of the scratchpad and the model keeps thinking normally from there.

Severity scales with length, channel, and how much conclusion you pre-commit. Six tokens in the scratchpad is close to free. Two hundred tokens of style and permission rules in `content` is not.

One thing worth weighing if you run continuity extensions: a seed like *"I should continue the story"* is a **permission** prefill, and it biases the opening of the scratchpad away from *"check the injected context first."* Seeding procedure costs the same and pushes the other way.

---

## How it works

The hook is `CHAT_COMPLETION_SETTINGS_READY`, which fires on the assembled `generate_data` object one statement before `JSON.stringify()`. Verified against SillyTavern staging `380e31e`:

- `ChatCompletion.getChat()` returns the array that becomes `generate_data.messages`
- `sendOpenAIRequest()` emits the event on that object, then serialises it
- `/api/backends/chat-completions/generate` applies `custom_prompt_post_processing`, then hands the request to a per-source handler which may apply its own

A field written on a message object here reaches the provider unchanged wherever nothing merges it away. Predicting that is most of what the engine does, and `st_sim.mjs` — a port of the server code — is what those predictions are checked against, so the gate asserts what the provider receives rather than what the engine believed it did. The same file backs **Run test**, so the panel shows you what the gate proves.

---

## Gates

```
node test.mjs           # engine logic
node wire_test.mjs      # engine output through a port of the SillyTavern server
node load_test.mjs      # real module against a mocked SillyTavern + jsdom
node fuzz_test.mjs      # seeded fuzz over the wire invariants
node negative_test.mjs  # reintroduces each bug and proves the gates catch it
npx eslint engine.js index.js st_sim.mjs
```

`negative_test.mjs` runs an unmutated control tree through every gate first. If a control run does not exit 0, the harness fails rather than reporting mutations as caught.

The gates above check the engine against `st_sim.mjs`. `st_sim.mjs` itself is checked against SillyTavern's own `src/prompt-converters.js`, run side by side over randomised inputs until the outputs match byte for byte, and the engine is run end to end through that real server code. Those two harnesses need a SillyTavern checkout, so they do not live here — but a change to `st_sim.mjs` that has not been through them is a guess.

---

## Changelog

### 1.5.0

Audit release. The port this extension's predictions are checked against was
itself checked — against SillyTavern's own source, run side by side over 40000
randomised inputs — and the engine was run end to end through the real server
code over 260000 randomised requests. Four defects, two of them silent.

- **A prefill the server was about to discard could be reported as a clean
  success.** SillyTavern's merge keeps the *earlier* message and drops the later
  one whole, so the continuation flag and the reasoning seed are lost together.
  The engine asked whether the flag would survive as part of writing the flag —
  which meant that with no flag configured, nothing was asked at all, and the
  reasoning seed disappeared with the panel reporting *Applied*. That is the
  default shape on OpenRouter's generic mapping and on custom endpoints, where
  the flag field is empty. The question is now asked once, about the message.
- **The merge guard being on did not mean there was no risk.** The guard stands
  down whenever it cannot reproduce the server's transform, and a previous
  message carrying an image or audio is exactly that case — the server flattens
  the media to text and merges anyway. Flag and seed were both discarded with
  nothing reported. Content the guard cannot predict now counts as at risk.
- **The settings panel never showed the prediction.** The engine has reported
  merge risk since 1.4.0 and the status line did not render it, so the one
  outcome the mechanism exists to prevent — *Applied* over a request the
  provider will never see the prefill in — reached the user anyway. The status
  line now says so, withholds the success colour, and names the right remedy,
  which is not the same one depending on whether the guard is already on.
- **A seed that will not arrive no longer switches the thinking channel on.**
  Opening it changed a provider-visible parameter with nothing to show for it.
- **The server simulator used the wrong prompt placeholder.** It carried
  `Let's get started.`, the fallback in SillyTavern's code, while
  `default/config.yaml` ships `promptPlaceholder: "[Start a new chat]"` and the
  server writes that into every install. Found by running the simulator against
  the real `prompt-converters.js`; it was the only difference in 40000 runs.
- **Two reason codes had no display text** and reached the settings panel as raw
  jargon. The gate now proves the map covers the enum in both directions.
- **The fuzz gate excluded multimodal requests from its wire pass**, which is
  what let the second defect above survive it. The exclusion is gone.
- 159 engine checks, 1907 wire checks over 560 provider/post-processing
  combinations, 152 load checks, 60000 fuzz runs, 66 proven mutations, 4 control
  runs.

### 1.4.0

Audit release. Five defects, each reproduced against a port of the SillyTavern
server before being fixed, and each now driving a mutation in the negative gate.

- **The merge guard was blind to post-processing the server applies on its own.**
  DeepSeek forces `semi_tools`, MiniMax `merge_tools` and Perplexity `strict`,
  whatever the user selected. With post-processing set to *None* the guard stood
  down, the server merged the tail into the message before it, and a thinking
  prefill vanished from the wire entirely while the panel reported *Applied*.
  The guard now reads the source as well as the setting.
- **The merge guard tested the wrong content.** `mergeMessages()` folds `name`
  into content before it decides whether to squash, so a thinking prefill —
  whose content is deliberately empty — was not empty by the time it was tested.
  Where character names are sent as a field, both the flag and the reasoning
  seed were merged away and lost. The guard now folds names the way the server
  does, which also makes its own merge byte-identical to the server's instead of
  silently dropping a name prefix.
- **The guard collapsed one assistant turn, not the run.** Three assistant
  messages in a row left two, and the server merged those.
- **A field name used for both the flag and the reasoning seed destroyed the
  seed.** The flag is written after the split, so `reasoning_content` became
  `true` and the panel called it a success. Colliding names are now refused.
- **A reasoning seed could be sent into a thinking channel the request had
  switched off.** `include_reasoning` is what the server maps to `thinking.type`
  on Moonshot, DeepSeek and Z.AI and to `reasoning.exclude` on OpenRouter; with
  it off the model ignores the seed or continues it as reply text. Requests
  carrying a seed now open the channel, and only those.
- **Skips no longer mutate.** Every reason to stand down is now evaluated before
  anything is written, so a report of *skipped* means the request went out
  exactly as SillyTavern built it. The fuzz gate asserts it byte for byte.
- **A flag that cannot survive is no longer reported as a clean success.** With
  the merge guard off the panel says so.
- **A multimodal tail behind a merging server is refused** rather than flagged,
  because the server rebuilds media through placeholder tokens and the flag
  cannot be carried across by hand.
- **In-panel guide**, explaining prefill, the continuation flag, content versus
  thinking prefill, and every setting.
- **Run test**, which puts your real settings through the real code path and
  shows the message the provider receives.
- 137 engine checks, 1907 wire checks over 560 provider/post-processing
  combinations, 130 load checks, 60000 fuzz runs, 58 proven mutations, 4 control
  runs.

### 1.3.0

Audit release. Five defects found and fixed.

- **Field names are validated before anything is touched.** `flagField` and `reasoningField` are free-text. Typing `content` produced `content: true` — a type error at the provider that destroyed the prefill in the same stroke; `role` produced an invalid role. Surrounding whitespace was worse: it serialised as a key the provider silently ignores while the panel still reported *Applied*. Reserved and malformed names now skip with an explanation, and names are trimmed.
- **The decision log no longer keeps message fields by reference.** A multimodal message painted about 60 kB of base64 image data into the panel and pinned the payload in memory. Object fields are flattened to bounded text.
- **A second load no longer mounts a duplicate copy.** Re-importing registered a second hook and a second settings panel with duplicate element ids.
- **Startup polls instead of assuming.** If SillyTavern's context was not ready by `DOMContentLoaded`, initialisation threw and the extension was permanently dead — no hook, no UI, no retry. The hook is now registered as soon as the context appears.
- **A late settings container no longer costs the UI permanently.** It is waited for separately, so prefill works even while the panel is still arriving.
- 131 engine checks, 100 load checks, 60000 fuzz runs, 47 proven mutations, 3 control runs.

### 1.2.0

- **Reset to defaults**, with a two-tap confirm and a four-second arming window. Restores every setting and drops keys left over from older versions.
- 91 engine checks, 82 load checks, 39 proven mutations.

### 1.1.0

- **Decision log in the settings panel.** The last ten requests with the final wire message, a copy button, and a clear button. Console-only logging was unusable on mobile, where SillyTavern is most often run.
- **Default prefill source is now the extension**, so enabling it works without editing a preset. Previously the default reported *"prompt does not end in an assistant message"* on a normal chat, which is the usual shape of a prompt.
- 91 engine checks, 66 load checks, 32 proven mutations.

### 1.0.0

- Initial release.
- Continuation flag and reasoning-field split, both with configurable field names.
- Provider field mappings for Moonshot, OpenRouter, DeepSeek, Anthropic, and generic OpenAI-compatible endpoints.
- Prefill sourced from the preset or supplied by the extension.
- Generation-type filter excluding utility and impersonation requests by default.
- Guards for tools, JSON schema, and single-message post-processing.
- Merge guard for server-side prompt post-processing.
- 89 engine checks, 51 load checks, 25 proven mutations.

---

## Licence

AGPL-3.0-or-later.
