/**
 * pi-context-cap
 *
 * Caps the reported `contextWindow` on selected models so pi's built-in
 * auto-compaction fires earlier than the model's native limit. Default
 * behavior targets long-context Claude models (1M window → 200k cap), but
 * the mechanism is fully general.
 *
 * No custom compaction logic: we tell pi the window is smaller and let
 * its existing `contextTokens > contextWindow - reserveTokens` trigger do
 * the work. All existing compaction behavior (hooks, summarization, error
 * handling) is preserved.
 *
 * What this is NOT:
 *   - A pricing-tier change. Current 1M Claude models bill at standard
 *     rates across the full window.
 *   - A serving-mode switch. There is no wire-level toggle that routes a
 *     capped request to a different serving path; the model identifier
 *     determines the mode.
 *
 * Config (optional; default is 200k cap on anthropic/claude models):
 *
 *   ~/.pi/agent/extensions/context-cap.json         (global)
 *   <cwd>/.pi/extensions/context-cap.json           (project override)
 *
 *   {
 *     "cap": 200000,                              // target contextWindow
 *     "appliesOver": 200000,                      // only touch models with native window > this
 *     "matchPatterns": ["anthropic", "claude"],   // id-substring match (case-insensitive); "*" matches all
 *     "models": {                                 // per-id overrides; always wins over pattern matching
 *       "claude-opus-4-7": 180000
 *     }
 *   }
 *
 * Caveat: pi's compaction trigger uses the *previous* assistant's reported
 * input-token count, so a single turn that injects more than `reserveTokens`
 * worth of new content (large tool output, pasted doc) can still cross the
 * cap. For strict guarantees, set `cap` lower than the target ceiling.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface CapConfig {
	/** Target contextWindow value to cap affected models at. */
	cap: number;
	/** Only cap models whose native contextWindow exceeds this value. */
	appliesOver: number;
	/**
	 * Substrings matched against `model.id` (case-insensitive) to decide which
	 * models the global cap applies to. The wildcard `"*"` matches every model.
	 * Per-model entries in `models` are applied regardless of this filter.
	 */
	matchPatterns: string[];
	/** Per-model-id overrides. Always wins over pattern matching. */
	models: Record<string, number>;
}

const DEFAULT_CONFIG: CapConfig = {
	cap: 200_000,
	appliesOver: 200_000,
	matchPatterns: ["anthropic", "claude"],
	models: {},
};

function loadConfig(cwd: string): CapConfig {
	const paths = [
		join(getAgentDir(), "extensions", "context-cap.json"),
		join(cwd, ".pi", "extensions", "context-cap.json"),
	];

	let cfg: CapConfig = {
		...DEFAULT_CONFIG,
		matchPatterns: [...DEFAULT_CONFIG.matchPatterns],
		models: { ...DEFAULT_CONFIG.models },
	};

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<CapConfig>;
			cfg = {
				cap: raw.cap ?? cfg.cap,
				appliesOver: raw.appliesOver ?? cfg.appliesOver,
				matchPatterns: raw.matchPatterns ?? cfg.matchPatterns,
				models: { ...cfg.models, ...(raw.models ?? {}) },
			};
		} catch (e) {
			console.error(`[context-cap] could not parse ${path}: ${e}`);
		}
	}

	return cfg;
}

function matchesPatterns(modelId: string, patterns: string[]): boolean {
	if (patterns.length === 0) return false;
	const id = modelId.toLowerCase();
	return patterns.some((p) => p === "*" || id.includes(p.toLowerCase()));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const cfg = loadConfig(ctx.cwd);

		let cappedCount = 0;
		for (const model of ctx.modelRegistry.getAll()) {
			const native = model.contextWindow;
			if (native == null || native <= 0) continue;

			// Per-model override wins over pattern matching and global cap.
			const perModelCap = cfg.models[model.id];
			if (perModelCap !== undefined) {
				if (native > perModelCap) {
					model.contextWindow = perModelCap;
					cappedCount++;
				}
				continue;
			}

			// Global cap: only applies to models matching the configured patterns
			// whose native window exceeds both the `appliesOver` threshold and the cap itself.
			if (
				native > cfg.appliesOver &&
				native > cfg.cap &&
				matchesPatterns(model.id, cfg.matchPatterns)
			) {
				model.contextWindow = cfg.cap;
				cappedCount++;
			}
		}

		if (cappedCount > 0) {
			ctx.ui.notify(
				`context-cap: capped ${cappedCount} model(s) to ≤ ${cfg.cap.toLocaleString()} tokens`,
				"info",
			);
		}
	});
}
