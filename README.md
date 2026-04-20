# pi-context-cap

[![npm version](https://img.shields.io/npm/v/pi-context-cap.svg)](https://www.npmjs.com/package/pi-context-cap)
[![license](https://img.shields.io/npm/l/pi-context-cap.svg)](./LICENSE)

A tiny [pi](https://github.com/badlogic/pi-mono) extension that caps model context windows so pi's built-in auto-compaction fires earlier. Zero-config for Anthropic's 200k pricing-tier boundary; fully configurable for other models and use cases.

## Primary use case: Anthropic's 200k pricing tier

Anthropic's long-context Claude models (Opus 4.6, Opus 4.7, Sonnet 4.6, and any future 1M-window variants) have a 1,000,000-token window but bill input and output at roughly **2× once a request crosses 200,000 input tokens** (the "long-context" tier). Pi's default auto-compaction trigger is:

```
contextTokens > contextWindow - reserveTokens
```

With a 1M window and the default `reserveTokens = 16384`, **compaction doesn't fire until ~983,616 tokens** — well into long-context pricing. A long session can quietly 2–3× its expected cost before pi ever tries to compact.

This extension's defaults fix exactly that. Install with no configuration:

```bash
pi install npm:pi-context-cap
```

Any Claude model with a native window >200k is silently capped at 200k. Pi's existing compaction logic then fires at ~183k — exactly like on a native-200k model. On Opus 4.7 you'll see:

```
Context: 182,411 / 200,000 (91%)
```

…and compaction kicks in at the normal time.

## Other use cases

The same mechanism generalises to anything where you'd want pi to compact before the model's native context limit:

- **Performance sweet spot** — many models degrade near their context limit. Cap all models at a fraction of their native window so compaction fires before quality craters.
- **Non-Anthropic cost control** — a provider's window may be large but per-token costs mount. Cap a 1M/2M model at e.g. 500k to keep spend predictable.
- **Per-model tuning** — different models summarise context differently. Set `"claude-opus-4-7": 200000` and `"claude-sonnet-4-6": 150000` if you want more headroom on one.
- **Testing and dev** — force compaction at a predictable point without burning through real tokens.

All of these are one-file config changes. See [Configure](#configure).

## Install

```bash
# From npm (recommended)
pi install npm:pi-context-cap

# Or directly from git
pi install git:github.com/AlexWootton/pi-context-cap

# Or local clone for development
git clone https://github.com/AlexWootton/pi-context-cap
pi install ./pi-context-cap
```

**Default behavior:** caps any model whose `id` contains `"anthropic"` or `"claude"` and whose native `contextWindow > 200_000`, down to exactly `200_000`. All other models are left alone.

## Configure

Drop a JSON file at either path:

| Location | Scope |
|---|---|
| `~/.pi/agent/extensions/context-cap.json` | Global |
| `<project>/.pi/extensions/context-cap.json` | Project (overrides global) |

### Schema

```jsonc
{
  "cap": 200000,                               // Target contextWindow for affected models.
  "appliesOver": 200000,                       // Only cap models whose native window exceeds this.
  "matchPatterns": ["anthropic", "claude"],    // id-substring match (case-insensitive). Use "*" to match all.
  "models": {                                  // Per-model-id overrides. Always win over pattern matching.
    "claude-opus-4-7": 180000
  }
}
```

All keys are optional. Values shown are the defaults.

### Examples

**Anthropic tier (the default — shown for reference):**

```json
{ "cap": 200000, "matchPatterns": ["anthropic", "claude"] }
```

**More conservative buffer below the tier boundary:**

```json
{ "cap": 180000 }
```

**Extend the default Anthropic cap to also cap Gemini at 500k:**

```json
{
  "cap": 200000,
  "matchPatterns": ["anthropic", "claude"],
  "models": {
    "google/gemini-2-5-pro": 500000,
    "google/gemini-2-5-flash": 500000
  }
}
```

**Only cap a specific model, leave everything else alone:**

```json
{
  "matchPatterns": [],
  "models": {
    "us.anthropic.claude-opus-4-7": 200000
  }
}
```

**Apply the same cap to every model in the registry (aggressive):**

```json
{
  "cap": 150000,
  "appliesOver": 150000,
  "matchPatterns": ["*"]
}
```

Model IDs match `model.id` exactly; run `pi --list-models` to see them. Unknown IDs in `models` are silently ignored.

## What it does and doesn't do

**Does:**
- Cap `contextWindow` on matching models so pi's built-in auto-compaction fires at the cap point.
- Show `capped N models` notification once on session start.
- Work with all of pi's compaction machinery (including `session_before_compact` hooks, manual `/compact`, and compaction error recovery) without modification.
- Apply project config on top of global config.

**Does not:**
- Replace or duplicate pi's compaction logic.
- Touch token billing, API requests, or the messages array.
- Cap any model if `matchPatterns` is empty *and* `models` has no entries (you've told it to do nothing).
- Prevent a *single* turn from crossing the cap if that turn's new content (large tool output, pasted document) exceeds the reserve buffer — see **Caveats**.

## Caveats

Pi's compaction trigger checks the **previous assistant's** reported input-token usage. So if one turn adds more than `reserveTokens` (default ~16k tokens) of fresh content — say, three large file reads plus a long bash dump — the next request may be sent with more input tokens than the cap despite this extension being active.

For typical conversational coding, this is rare. For strict guarantees:

- Set `cap` below your actual ceiling (e.g. `180000` to stay well under 200k).
- Or bump `compaction.reserveTokens` in `~/.pi/agent/settings.json` (affects *all* models, not just the capped ones).

## See also

- [`pi-custom-compaction`](https://www.npmjs.com/package/pi-custom-compaction) — swaps pi's compaction model, template, *and* trigger point. Its `trigger.maxTokens` option overlaps with this extension's core function. Choose `pi-custom-compaction` if you also want to swap the summarizer model or get per-project compaction-policy control; choose `pi-context-cap` if you only want per-model trigger caps with zero-config defaults and `/context` that honestly reflects your working ceiling.
- [`pi-model-aware-compaction`](https://www.npmjs.com/package/pi-model-aware-compaction) — per-model **percent-based** compaction thresholds using a different mechanism (inflating reported token counts to trigger pi's compaction). Good when you think in percentages; this extension is better when you think in absolute tokens.
- [`pi-budget-guard`](https://www.npmjs.com/package/pi-budget-guard) — tracks **dollar spend** per session and blocks tool calls at a $ threshold. Complementary (dollars ≠ tokens); safe to run alongside.

## How it works

Pi's `ModelRegistry.getAll()` returns a live array of `Model` objects. The extension mutates `model.contextWindow` on each matching entry at `session_start` before any LLM request is built. Pi's [`shouldCompact()`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) reads this value directly:

```typescript
export function shouldCompact(contextTokens, contextWindow, settings) {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}
```

So the cap flows through to every existing compaction code path automatically. The extension itself is under 50 lines of logic.

### A note on extension load order

Extensions are loaded in this order:

1. Installed packages (from `settings.json`'s `packages` array)
2. Ad-hoc extensions passed via `--extension` / `-e`

Each extension's `session_start` handler fires in the same order. If you combine this extension with another loaded via `-e` that reads `contextWindow` in its own `session_start` handler, the other extension may see the *pre-cap* value. Mitigations:

- Read `contextWindow` in `before_agent_start` or later — by then the cap is applied.
- Or install both extensions as packages (order within packages is settings-file order).
- Or pass this one first when using `-e`: `pi -e path/to/context-cap.ts -e path/to/other.ts`.

For typical single-extension usage this is a non-issue.

## Uninstall

```bash
pi remove npm:pi-context-cap
```

Fully reversible. Pi's ModelRegistry is rebuilt on each launch from pi-ai's canonical model list, so removing the extension restores every affected model's native window on the next startup.

## License

MIT. See [LICENSE](./LICENSE).
