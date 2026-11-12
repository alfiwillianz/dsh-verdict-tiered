/**
 * dsh-verdict-tiered — a permission gate for DeepSeek Harness (dsh).
 *
 * A fork of [jesset/pi-verdict](https://github.com/jesset/pi-verdict), re-targeted
 * from pi's extension API onto DSH's Cordis plugin surface. The adjudication
 * pipeline is unchanged (see `./verdict.ts`); this module owns the host seam:
 *
 *   - `tools/pre-execute` (prepended) — the gate itself. Every native call is
 *     adjudicated before its body; the verdict maps onto DSH's decision vocabulary:
 *     allow → `{kind:'allow'}`, deny → `{kind:'deny'}`, ask → `{kind:'ask'}`.
 *     DSH routes `ask` through its approval seam, so a session with no answerer
 *     fails closed without this plugin implementing any UI.
 *   - the `auto` permission preset — registered through
 *     `permissionPresets.registerAuto()`, so `/permission auto` selects the gate
 *     and the picker shows it. The preset is the master switch.
 *   - `/automode` — status and on/off, switching the preset.
 *   - a dsh-tui footer field — `auto mode on|off`, when the TUI is composed.
 *
 * The gate is active only while the session's preset is `auto`; every other
 * preset leaves the host's own permission model in charge.
 *
 * @module dsh-verdict-tiered
 */

import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { AUTO_PRESET } from "@deepseek-ai/dsh-permission-presets";
// Type-only: resolve the tools pipeline event declarations.
import type {} from "@deepseek-ai/dsh-tools";
// Type-only: resolve ctx.approval / ctx.permissionPresets / ctx.commands.
import type {} from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-permission-presets";
import type {} from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-working-directory";
import {
	IntegrityWatch,
	MAX_ACTION_CHARS,
	OWN_FILE_PATH,
	SessionState,
	adjudicate,
	agentDirPath,
	buildProtectedSet,
	toolCallLine,
	type BranchEntry,
	type CompletionFn,
	type PipelineHost,
	type ResolvedLayer,
	type ThinkingLevel,
	type Verdict,
} from "./verdict.js";

declare module "@deepseek-ai/dsh-llm" {
	interface LlmRequestPurposeMap {
		"auto-mode-classifier": true;
	}
}

/** Cordis plugin name used by loader diagnostics. */
export const name = "verdict-tiered";

/** Services that must be composed before the gate may advertise itself. */
export const inject = ["tools", "llm", "permissionPresets", "approval", "sessions", "workingDirectory"];

/** Reserved model-facing program transport name (PTC). The outer `run_code`
 *  transport is deliberately not adjudicated: its inner calls are. */
const RUN_CODE_NAME = "run_code";

/** Plugin configuration. User *rules* live in `<dshHome>/dsh-verdict.json` and are
 *  self-protected (ADR-0001); these knobs are composition-level and safe to keep
 *  in the profile patch. */
export interface Config {
	/** Master switch for the gate within the `auto` preset. */
	enabled?: boolean;
	/** Notify every verdict, including allows. */
	debug?: boolean;
	/** Classifier route as `provider/model[:level]`; empty inherits the session's
	 *  active route (self-reflection). */
	classifierModel?: string;
}

export const Config: Schema<Config> = Schema.object({
	enabled: Schema.boolean().default(true).description("Gate tool calls while the session's permission preset is `auto`."),
	debug: Schema.boolean().default(false).description("Notify every verdict, including allows."),
	classifierModel: Schema.string().default("").description("Classifier route as provider/model[:level]; empty inherits the session route."),
});

/** The preset the gate falls back to when it is switched off. */
const FALLBACK_PRESET = "workspace-write";

/** Agent-facing block reason (#53): self-sufficient text, because structural error
 *  signaling does not reach every provider lane and a terse rule reason can read
 *  as a transient failure rather than a decision. */
function blockedReason(tag: string, detail: string): string {
	const clean = detail.trim().replace(/\.+$/, "");
	return `[auto-mode ${tag} block] BLOCKED — this action did NOT run. Reason: ${clean || "(no further reason given)"}. Report the block to the user; never claim it succeeded or completed.`;
}

/** Parse `provider/model[:level]` into a resolved layer, or null when malformed. */
export function parseModelSpec(raw: string): ResolvedLayer | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const colon = trimmed.lastIndexOf(":");
	const hasLevel = colon > trimmed.lastIndexOf("/") && colon !== -1;
	const route = hasLevel ? trimmed.slice(0, colon) : trimmed;
	const level = hasLevel ? (trimmed.slice(colon + 1) as ThinkingLevel) : "off";
	const slash = route.indexOf("/");
	if (slash <= 0 || slash === route.length - 1) return null;
	return { kind: "chat", provider: route.slice(0, slash), model: route.slice(slash + 1), thinking: level };
}

/** Structural view of the TUI services this plugin optionally uses. dsh-tui is not
 *  a dependency: the gate must work in Web and headless profiles too. */
interface TuiSurface {
	tuiStatus?: {
		setField(key: string, text: string, options?: { slot?: string; tone?: string; maxCells?: number; detail?: string }): void;
		clearField?(key: string): void;
	};
	tuiToast?: {
		show?(text: string, options?: { tone?: string }): void;
	};
}

/** The per-session gate state: rules, protected set, audit sink, and the tamper
 *  baseline (ADR-0001). One entry per live session. */
interface GateSession {
	state: SessionState;
	integrity: IntegrityWatch;
	/** Anchored once, on the first call that resolves a cwd. */
	anchored: boolean;
}

export function apply(ctx: Context, config: Config): void {
	const permissionPresets = ctx.permissionPresets;
	const tui = ctx as Context & TuiSurface;
	const sessions = new Map<string, GateSession>();
	let accepting = true;
	const lifecycle = new AbortController();

	/** Notify through the TUI when one is composed; a no-op elsewhere. */
	function notify(text: string, tone: "info" | "warning" = "info"): void {
		tui.tuiToast?.show?.(text, { tone });
	}

	/** Resolve the classifier route for one agent: the configured route wins,
	 *  otherwise the session's own route (self-reflection). */
	function resolveRoute(agent: Agent): ResolvedLayer | null {
		const configured = parseModelSpec(config.classifierModel ?? "");
		if (configured) return configured;
		const header = agent.session.requestHeader();
		if (header === undefined) return null;
		const provider = header.config.provider;
		const model = header.config.model;
		if (!provider || !model) return null;
		const thinking = (header.config.reasoningEffort ?? "off") as ThinkingLevel;
		return { kind: "chat", provider, model, thinking };
	}

	/** Bind DSH's streaming LLM seam to the pipeline's completion contract. */
	const complete: CompletionFn = async (req) => {
		try {
			const assembler = new BlockAssembler();
			let finished = false;
			const stream = ctx.llm.stream({
				provider: req.provider,
				model: req.model,
				system: req.system,
				messages: [{ role: "user", content: [{ type: "text", text: req.messages[0]?.content ?? "" }] }],
				...(req.temperature === undefined ? {} : { temperature: req.temperature }),
				maxTokens: req.maxTokens,
				...(req.reasoningEffort === undefined ? {} : { reasoningEffort: req.reasoningEffort as unknown as ReasoningEffortId }),
				...(req.signal === undefined ? {} : { signal: req.signal }),
				purpose: "auto-mode-classifier",
			});
			for await (const chunk of stream) {
				assembler.push(chunk);
				if (chunk.type !== "finish") continue;
				finished = true;
				if (chunk.reason.kind !== "stop") {
					const detail = chunk.reason.kind === "error" || chunk.reason.kind === "aborted" ? `: ${chunk.reason.failure.message}` : "";
					return { ok: false, error: `classifier stream ended with ${chunk.reason.kind}${detail}` };
				}
			}
			if (!finished) return { ok: false, error: "classifier stream emitted no terminal finish" };
			const text = assembler
				.blocks()
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			return { ok: true, text };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	};

	/** Adapt DSH's session log to the pipeline's transcript source.
	 *  `snapshotEvents()` is the deprecated synchronous reader, used here under the
	 *  same line-scoped waiver as the shipped auto-review integration: no paged
	 *  reader exists for prior calls yet. */
	function pipelineHost(agent: Agent): PipelineHost {
		return {
			getSessionId: () => agent.session.id,
			getBranch: () => {
				const entries: BranchEntry[] = [];
				for (const event of agent.session.snapshotEvents()) {
					if (event.type === "user/message") {
						const blocks = event.data.content;
						const text = Array.isArray(blocks)
							? blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n")
							: "";
						if (text.trim()) entries.push({ type: "message", message: { role: "user", content: text } });
					} else if (event.type === "tool/call") {
						let args: unknown = {};
						try {
							args = JSON.parse(event.data.arguments);
						} catch {
							args = event.data.arguments;
						}
						entries.push({
							type: "message",
							message: { role: "assistant", content: [{ type: "toolCall", name: event.data.name, arguments: args }] },
						});
					}
				}
				return entries;
			},
		};
	}

	/** Create or reuse the gate state for one session. */
	function gateFor(agent: Agent): GateSession {
		const id = agent.session.id;
		let gate = sessions.get(id);
		if (gate === undefined) {
			const agentDir = agentDirPath();
			gate = {
				state: new SessionState(buildProtectedSet(agentDir, OWN_FILE_PATH), undefined, agentDir),
				integrity: new IntegrityWatch(buildProtectedSet(agentDir, OWN_FILE_PATH).watchBases),
				anchored: false,
			};
			sessions.set(id, gate);
		}
		return gate;
	}

	/** Map one verdict onto DSH's pre-execute decision vocabulary. */
	function toDecision(v: Verdict): { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask"; reason: string } {
		if (v.verdict === "allow") return { kind: "allow" };
		if (v.verdict === "deny") return { kind: "deny", reason: blockedReason(v.source, v.reason) };
		// DSH owns the approval seam: `ask` reaches the configured answerers and
		// fails closed when none exist, which is exactly the ask-degradation rule.
		return { kind: "ask", reason: v.reason };
	}

	/** Refresh the dsh-tui footer field, when the TUI is composed. */
	function refreshStatus(session: Session): void {
		if (tui.tuiStatus === undefined) return;
		const active = permissionPresets.current(session) === AUTO_PRESET;
		tui.tuiStatus.setField("auto-mode", active ? "auto mode on" : "auto mode off", {
			slot: "right-tail",
			tone: active ? "success" : "warning",
			maxCells: 16,
			detail: active
				? "dsh-verdict-tiered: rules + classifier gate every tool call"
				: "dsh-verdict-tiered: gate inactive (permission preset is not auto)",
		});
	}

	ctx.effect(function* () {
		yield ctx.on(
			"tools/pre-execute",
			async (exec, next) => {
				const agent = exec.agent;
				// The outer PTC transport is not adjudicated; its inner calls are.
				if (agent === undefined || (exec.parent === undefined && exec.name === RUN_CODE_NAME)) return next();
				if (!config.enabled) return next();
				if (permissionPresets.current(agent.session) !== AUTO_PRESET) return next();
				if (!accepting || lifecycle.signal.aborted) return { kind: "cancel" };

				const gate = gateFor(agent);
				const signal = AbortSignal.any([exec.signal, lifecycle.signal]);

				// Layer 0 precondition: tamper detection (ADR-0001). A session that has
				// seen a protected-file change stays fail-closed until it restarts.
				if (gate.integrity.tampered) {
					const action = toolCallLine(exec.name, exec.arguments as Record<string, unknown>, MAX_ACTION_CHARS);
					notify(`🛡️ Auto Mode blocked: self-protection fail-closed (tamper detected this session; restart to reset)\n  ${action}`, "warning");
					return {
						kind: "deny",
						reason: blockedReason("tamper", "self-protection: fail-closed until session restart (protected file was tampered with)"),
					};
				}
				const changed = gate.integrity.detect();
				if (changed.length > 0) {
					// Differential disposal: a changed extension copy always restores and
					// fails closed; a config change is re-baselined so a user's in-session
					// hand edit is not a permanent lockout.
					const restored = gate.integrity.restoreAndFailClose(changed, "protected file changed bypassing the gate");
					notify(`🛡️ dsh-verdict-tiered TAMPER DETECTED: ${restored.files} modified bypassing the gate; restored where possible. Fail-closed for the rest of this session.`, "warning");
					return { kind: "deny", reason: blockedReason("tamper", restored.reason) };
				}

				const cwd = await ctx.workingDirectory.ensure(agent, signal);
				if (!gate.anchored) {
					const report = gate.state.reset(cwd);
					gate.anchored = true;
					if (report.skipped.length > 0) {
						notify(`dsh-verdict-tiered: skipped ${report.skipped.length} invalid config value(s): ${report.skipped.join(", ")}`, "warning");
					}
				}

				const action = toolCallLine(exec.name, exec.arguments as Record<string, unknown>, MAX_ACTION_CHARS);
				const verdict = await adjudicate(
					gate.state,
					{ toolName: exec.name, input: exec.arguments as Record<string, unknown>, toolCallId: exec.callId },
					{
						cwd,
						// DSH's approval seam owns ask degradation: report a UI so the
						// pipeline emits `ask`, and let the seam fail closed when no
						// answerer is composed.
						hasUI: true,
						getModel: () => resolveRoute(agent),
						complete,
						host: pipelineHost(agent),
						signal,
					},
				);

				const auditWarning = gate.state.audit?.drainWarning();
				if (auditWarning) notify(`dsh-verdict-tiered: ${auditWarning}`, "warning");

				// Notification discipline: judgment surfaces, mechanical passes stay quiet.
				if (verdict.verdict === "allow") {
					if (config.debug) notify(`🛡️ allow (${verdict.source}): ${action}`);
					else if (gate.state.userRules.notifyAllows && verdict.source === "classifier") notify(`🛡️ allow (classifier): ${verdict.reason}\n  ${action}`);
				} else if (verdict.verdict === "deny") {
					// A protected-path notification never carries the path or the action line
					// (ADR-0002's zero-leak promise).
					notify(verdict.source === "protected-path" ? `🛡️ Auto Mode blocked: ${verdict.reason}` : `🛡️ Auto Mode blocked: ${verdict.reason}\n  ${action}`, "warning");
				}

				// #62: an interactive ask's audit record is finalized after the decision.
				if (verdict.pendingAudit !== undefined) {
					const decision = toDecision(verdict);
					gate.state.audit?.append({
						...verdict.pendingAudit,
						userAnswer: decision.kind === "ask" ? "allowed" : "declined",
						answeredAt: new Date().toISOString(),
					});
					verdict.pendingAudit = undefined;
					return decision;
				}
				return toDecision(verdict);
			},
			{ prepend: true },
		);

		// The `auto` preset is the master switch: selecting it turns the gate on.
		yield permissionPresets.registerAuto(() => {
			if (!accepting) throw new Error("dsh-verdict-tiered: integration is closing");
		});

		// `/automode` — status and on/off, switching the permission preset. The
		// command registry is optional (a headless profile may omit it), so it is
		// mounted through a nested fiber that only activates when it is composed.
		ctx.inject(["commands"], (commandCtx) => {
			commandCtx.commands.register({
				name: "automode",
				description: "Show or switch the verdict gate (auto mode)",
				handler: (invocation: { agent: Agent; rawInput: string }) => {
					const arg = invocation.rawInput.trim().toLowerCase();
					const current = permissionPresets.current(invocation.agent.session);
					if (arg === "on") {
						permissionPresets.set(invocation.agent.session, AUTO_PRESET);
						refreshStatus(invocation.agent.session);
						return { kind: "success", text: "🛡️ Auto Mode: on — rules + classifier gate every tool call" };
					}
					if (arg === "off") {
						permissionPresets.set(invocation.agent.session, FALLBACK_PRESET);
						refreshStatus(invocation.agent.session);
						return { kind: "success", text: `Auto Mode: off — permission preset switched to ${FALLBACK_PRESET}` };
					}
					const active = current === AUTO_PRESET;
					return {
						kind: "success",
						text: `${active ? "🛡️ Auto Mode: on" : "Auto Mode: off"}\nPermission preset: ${current}\nUsage: /automode on | /automode off`,
					};
				},
			});
		});

		// Keep the footer honest across preset switches made through the picker.
		yield ctx.on("permission-presets/catalog-changed", () => {
			for (const agent of ctx.sessions.list()) refreshStatus(agent);
		});

		yield async () => {
			accepting = false;
			lifecycle.abort(new Error("dsh-verdict-tiered integration disposed"));
			sessions.clear();
		};
	}, "verdict-tiered lifecycle");
}
