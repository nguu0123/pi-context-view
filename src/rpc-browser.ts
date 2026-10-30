/** Paged RPC drill-down. Only an explicit Preview action sends content to the client. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { ContextUsageSnapshot, InjectionItem, InjectionSection, InjectionSnapshot, UsageCategory } from "./model.ts";
import { normalizeInlineText, normalizeMultilineText } from "./text.ts";

const PAGE_SIZE = 30;
const PREVIEW_LIMIT = 40_000;
const PREVIEW_ACTION = "Preview text (client may retain it)";

interface Node {
	readonly label: string;
	readonly tokens: number;
	readonly children?: () => readonly Node[];
	readonly text?: () => string;
}

interface Frame {
	readonly node: Node;
	readonly children: readonly Node[];
	page: number;
}

export async function browseRpcUsage(context: ExtensionCommandContext, usage: ContextUsageSnapshot): Promise<void> {
	await browse(context, { label: "Context usage", tokens: usage.estimatedTokens,
		children: () => usage.categories.map(categoryNode) });
}

export async function browseRpcInjections(context: ExtensionCommandContext, snapshot: InjectionSnapshot): Promise<void> {
	await browse(context, { label: "Context injections", tokens: snapshot.totalTokens,
		children: () => snapshot.groups.map((group) => ({
			label: group.source.label, tokens: group.totalTokens, children: () => group.items.map(itemNode),
		})) });
}

function categoryNode(category: UsageCategory): Node {
	return { label: category.label, tokens: category.tokens, children: () => [
		...(category.children ?? []).map(categoryNode),
		...(category.entries ?? []).map((entry) => contentNode(
			entry.breadcrumb.join(" / ") + (entry.timestamp === undefined ? "" : ` — ${entry.timestamp}`),
			entry.tokens, entry,
		)),
	] };
}

function itemNode(item: InjectionItem): Node {
	return { ...contentNode(item.label, item.tokens, item),
		children: () => item.children?.length ? item.children.map(itemNode) : (item.sections ?? []).map(sectionNode) };
}

function sectionNode(section: InjectionSection): Node {
	return contentNode(section.label, section.tokens, section);
}

function contentNode(name: string, tokens: number, content: { readonly text: string; readonly sections?: readonly InjectionSection[] }): Node {
	return { label: name, tokens, text: () => content.text,
		children: () => (content.sections ?? []).map(sectionNode) };
}

async function browse(context: ExtensionCommandContext, root: Node): Promise<void> {
	const stack: Frame[] = [frame(root)];
	while (stack.length > 0) {
		const current = stack.at(-1);
		if (current === undefined) return;
		const offset = current.page * PAGE_SIZE;
		const rows = current.children.slice(offset, offset + PAGE_SIZE);
		const options = rows.map((node, i) => `${offset + i + 1}. ${label(node.label)} (${node.tokens.toLocaleString("en-US")} tokens)`);
		if (current.node.text !== undefined) options.push(PREVIEW_ACTION);
		if (offset > 0) options.push("Previous page");
		if (offset + PAGE_SIZE < current.children.length) options.push("Next page");
		if (stack.length > 1) options.push("Back");
		options.push("Close");
		const selected = await context.ui.select(label(current.node.label), options, { timeout: 120_000, signal: context.signal });
		if (selected === undefined || selected === "Close" || !options.includes(selected)) return;
		if (selected === "Back") { stack.pop(); continue; }
		if (selected === "Next page") { current.page++; continue; }
		if (selected === "Previous page") { current.page--; continue; }
		if (selected === PREVIEW_ACTION && current.node.text !== undefined) {
			const text = current.node.text();
			const preview = normalizeMultilineText(text.slice(0, PREVIEW_LIMIT)) || "(No visible text; content may be encoded or deleted.)";
			// Editor results are deliberately ignored: browsing never edits the captured request.
			await context.ui.editor(`Preview: ${label(current.node.label)} (edits discarded)`,
				preview + (text.length > PREVIEW_LIMIT ? "\n\n[Preview truncated at 40,000 characters]" : ""));
			stack.pop();
			continue;
		}
		const index = options.indexOf(selected);
		const next = index < 0 ? undefined : rows[index];
		if (next === undefined) return;
		stack.push(frame(next));
	}
}

function frame(node: Node): Frame {
	return { node, children: node.children?.() ?? [], page: 0 };
}

function label(text: string): string {
	return normalizeInlineText(text).slice(0, 160);
}
