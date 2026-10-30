import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CATEGORY_COLORS, DEFAULT_MAP_SIZE } from "../src/config.ts";
import { showRpcInjections, showRpcUsage } from "../src/rpc.ts";

function recorder() {
	const messages: string[] = [];
	const context = { ui: { notify: (message: string) => messages.push(message) } } as unknown as ExtensionCommandContext;
	return { context, messages };
}

test("RPC usage separates reported and estimated totals, sanitizes labels, and omits previews", async () => {
	const { context, messages } = recorder();
	await showRpcUsage(context, {
		usage: {
			computedAt: new Date(), modelLabel: "test\u001b[31m\nmodel",
			reported: { tokens: 30, contextWindow: 100, percent: 30 }, estimatedTokens: 40,
			autoCompactReserveTokens: 10,
			categories: [{ id: "user-messages", label: "User\nMessages", tokens: 40,
				entries: [{ breadcrumb: ["user"], tokens: 40, text: "PRIVATE_PREVIEW" }] }],
		},
		categoryColors: DEFAULT_CATEGORY_COLORS, mapSize: DEFAULT_MAP_SIZE,
	});
	assert.equal(messages.length, 1);
	assert.match(messages[0], /Reported: 30 \/ 100 tokens \(30.0%\)/);
	assert.match(messages[0], /Estimated total: 40 tokens/);
	assert.match(messages[0], /Auto-compaction reserve: 10 tokens/);
	assert.match(messages[0], /User Messages: 40/);
	assert.doesNotMatch(messages[0], /PRIVATE_PREVIEW|\u001b/);
});

test("RPC usage marks unknown reported counts instead of inventing zero after compaction", async () => {
	for (const reported of [undefined, { contextWindow: 0 }]) {
		const { context, messages } = recorder();
		await showRpcUsage(context, {
			usage: { computedAt: new Date(), reported, categories: [], estimatedTokens: 40 },
			categoryColors: DEFAULT_CATEGORY_COLORS, mapSize: DEFAULT_MAP_SIZE,
		});
		assert.match(messages[0], /Reported usage unavailable/);
		assert.match(messages[0], /Estimated total: 40 tokens/);
		assert.doesNotMatch(messages[0], /NaN|Infinity|Reported: 0/);
	}
});

test("RPC injections bounds large reports and never serializes raw snapshot fields", async () => {
	const { context, messages } = recorder();
	const source = { id: "fixture", label: "Source", native: false };
	await showRpcInjections(context, {
		snapshot: { totalTokens: 200, groups: [{ source, totalTokens: 200,
			items: Array.from({ length: 200 }, (_, index) => ({
				id: String(index), kind: "message", label: `item-${index}${"x".repeat(1000)}`,
				tokens: 1, chars: 16, text: "PRIVATE_SNAPSHOT", source,
			})),
		}] },
		guard: { status: "incomplete", reason: "PRIVATE_GUARD_REASON" },
		probe: true,
	});
	assert.equal(messages.length, 1);
	assert.ok(messages[0].length < 20_000);
	assert.match(messages[0], /Further contributions omitted/);
	assert.match(messages[0], /Payload comparison: incomplete/);
	assert.match(messages[0], /silent probe/);
	assert.doesNotMatch(messages[0], /PRIVATE_/);
});
