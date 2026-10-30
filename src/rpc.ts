/** RPC summaries stay metadata-only; interactive dialogs provide opt-in previews. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { browseRpcInjections, browseRpcUsage } from "./rpc-browser.ts";
import { normalizeInlineText } from "./text.ts";
import type { InjectionsViewInput } from "./ui/injections-view.ts";
import type { UsageViewInput } from "./ui/usage-view.ts";

const MAX_ROWS = 80;
const MAX_LABEL_LENGTH = 160;

/** Show the same usage estimates as the TUI through Pi's RPC notification protocol. */
export async function showRpcUsage(context: ExtensionCommandContext, input: UsageViewInput): Promise<void> {
	const { usage } = input;
	const lines = ["Context usage", `Model: ${label(usage.modelLabel ?? "unknown")}`];
	const reported = usage.reported;
	if (reported?.tokens !== undefined) {
		lines.push(`Reported: ${tokens(reported.tokens)} / ${tokens(reported.contextWindow)} tokens${percent(reported.tokens, reported.contextWindow)}`);
	} else {
		lines.push("Reported usage unavailable; category counts below are estimates.");
	}
	lines.push(`Estimated total: ${tokens(usage.estimatedTokens)} tokens`);
	if (reported !== undefined) {
		lines.push(`Context window: ${tokens(reported.contextWindow)} tokens${percent(usage.estimatedTokens, reported.contextWindow)}`);
	}
	if (usage.autoCompactReserveTokens !== undefined) {
		lines.push(`Auto-compaction reserve: ${tokens(usage.autoCompactReserveTokens)} tokens`);
	}
	lines.push("", "Estimated categories (tokens):");
	for (const category of usage.categories) lines.push(`${label(category.label)}: ${tokens(category.tokens)}`);
	showReport(context, lines, input);
	await browseRpcUsage(context, usage);
}

/** Report metadata before offering source/item navigation and opt-in previews. */
export async function showRpcInjections(context: ExtensionCommandContext, input: InjectionsViewInput): Promise<void> {
	const lines = ["Context injections", `Estimated total: ${tokens(input.snapshot.totalTokens)} tokens`];
	if (input.probe) lines.push("Source: silent probe, not a dispatched request.");
	if (input.guard !== undefined) lines.push(`Payload comparison: ${input.guard.status}`);
	if (input.snapshot.hiddenTools?.length) lines.push(`Hidden tools: ${input.snapshot.hiddenTools.length}`);
	lines.push("", "Estimated contributions (tokens):");
	for (const group of input.snapshot.groups) {
		lines.push(`${label(group.source.label)}: ${tokens(group.totalTokens)}`);
		for (const item of group.items) {
			if (lines.length >= MAX_ROWS) {
				lines.push("Further contributions omitted from summary; browse the menus to inspect them.");
				showReport(context, lines, input);
				await browseRpcInjections(context, input.snapshot);
				return;
			}
			lines.push(`  ${label(item.label)}: ${tokens(item.tokens)}${item.change ? ` [${item.change}]` : ""}${item.diffOnly ? " (counted in System Prompt)" : ""}`);
		}
	}
	showReport(context, lines, input);
	await browseRpcInjections(context, input.snapshot);
}

/** Reports stay outside the saved session and subsequent model context. */
function showReport(
	context: ExtensionCommandContext,
	lines: string[],
	input: { readonly degradedReason?: string; readonly probingDisabled?: boolean; readonly notices?: readonly string[] },
): void {
	if (input.probingDisabled) lines.push("Automatic probing disabled; request-only additions have not been observed.");
	if (input.degradedReason !== undefined) lines.push(`Fallback: ${label(input.degradedReason)}`);
	for (const notice of input.notices?.slice(0, 3) ?? []) lines.push(`Notice: ${label(notice)}`);
	context.ui.notify(lines.join("\n"), "info");
}

function label(text: string): string {
	const safe = normalizeInlineText(text);
	return safe.length <= MAX_LABEL_LENGTH ? safe : `${safe.slice(0, MAX_LABEL_LENGTH)}…`;
}

function tokens(value: number): string {
	return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function percent(value: number, window: number): string {
	return window > 0 ? ` (${(100 * value / window).toFixed(1)}%)` : "";
}
