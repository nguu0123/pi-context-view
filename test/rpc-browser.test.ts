import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CATEGORY_COLORS, DEFAULT_MAP_SIZE } from "../src/config.ts";
import { showRpcInjections, showRpcUsage } from "../src/rpc.ts";

const PREVIEW = "Preview text (client may retain it)";
const choose = (text: string) => (options: string[]) => {
	const choice = options.find((option) => option.includes(text));
	assert.ok(choice, `Expected ${text} in ${JSON.stringify(options)}`);
	return choice;
};

type Choice = (options: string[]) => string | undefined;
function dialogs(choices: Choice[]) {
	const notices: string[] = [];
	const previews: Array<{ title: string; text: string }> = [];
	const context = { ui: {
		notify: (message: string) => { notices.push(message); },
		select: async (_title: string, options: string[]) => {
			const next = choices.shift();
			assert.ok(next, "unexpected extra dialog");
			return next(options);
		},
		editor: async (title: string, text: string) => {
			previews.push({ title, text });
			return "USER_EDITS_MUST_BE_IGNORED";
		},
	} } as unknown as ExtensionCommandContext;
	return { context, notices, previews, choices };
}

function usage(entries: number) {
	return {
		usage: { computedAt: new Date(), estimatedTokens: entries, categories: [{
			id: "user-messages", label: "User Messages", tokens: entries,
			entries: Array.from({ length: entries }, (_, i) => ({ breadcrumb: ["user"], tokens: 1,
				text: `PRIVATE_ENTRY_${i + 1}\u001b[31m`, timestamp: i })),
		}] }, categoryColors: DEFAULT_CATEGORY_COLORS, mapSize: DEFAULT_MAP_SIZE,
	};
}

test("RPC usage drills into entries, previews only on opt-in, and returns Back without using edits", async () => {
	const ui = dialogs([choose("User Messages"), choose("1. user"), choose(PREVIEW), choose("Back"), () => undefined]);
	await showRpcUsage(ui.context, usage(1));
	assert.equal(ui.choices.length, 0);
	assert.equal(ui.previews.length, 1);
	assert.match(ui.previews[0].title, /edits discarded/i);
	assert.equal(ui.previews[0].text, "PRIVATE_ENTRY_1");
	assert.doesNotMatch(ui.notices.join("\n"), /PRIVATE_ENTRY|USER_EDITS/);
});

test("RPC menus page large lists, preserve the page after Back, and cancel without previews", async () => {
	const ui = dialogs([
		choose("User Messages"), choose("Next page"), choose("31. user"), choose("Back"),
		(options) => { assert.ok(options.some((option) => option.startsWith("31. user"))); return undefined; },
	]);
	await showRpcUsage(ui.context, usage(65));
	assert.equal(ui.choices.length, 0);
	assert.equal(ui.previews.length, 0);
	assert.doesNotMatch(ui.notices.join("\n"), /PRIVATE_ENTRY/);
});

test("RPC injections drills through groups, child items, and sections; previews are bounded", async () => {
	const source = { id: "fixture", label: "Fixture", native: false };
	const ui = dialogs([choose("Fixture"), choose("Tools"), choose("read"), choose("Definition"), choose(PREVIEW), () => undefined]);
	await showRpcInjections(ui.context, { snapshot: { totalTokens: 2, groups: [{ source, totalTokens: 2, items: [{
		id: "tools", kind: "tool", label: "Tools", tokens: 2, chars: 8, text: "PRIVATE_PARENT", source,
		children: [{ id: "read", kind: "tool", label: "read", tokens: 2, chars: 8, text: "PRIVATE_TOOL", source,
			sections: [{ label: "Definition", tokens: 2, text: "PRIVATE_SECTION" + "x".repeat(100_000) }],
		}],
	}] }] } });
	assert.equal(ui.choices.length, 0);
	assert.equal(ui.previews.length, 1);
	assert.match(ui.previews[0].text, /^PRIVATE_SECTION/);
	assert.match(ui.previews[0].text, /truncated/i);
	assert.ok(ui.previews[0].text.length < 41_000);
	assert.doesNotMatch(ui.notices.join("\n"), /PRIVATE_/);
});
