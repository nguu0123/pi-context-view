import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { RpcClient } from "@earendil-works/pi-coding-agent";

import { startMockProvider } from "./harness/mock-provider.ts";

// Exercise the real JSONL transport used by GUI clients, without user settings or credentials.
test("RPC context views report metadata without provider requests or persisted previews", { timeout: 30_000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "context-rpc-"));
	const provider = await startMockProvider();
	const client = new RpcClient({
		cliPath: fileURLToPath(new URL("bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))),
		cwd: directory,
		env: { PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1" },
		provider: "rpc-test",
		model: "test",
		args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
			"--append-system-prompt", "PRIVATE_RPC_PROMPT_CONTENT",
			"-e", fileURLToPath(new URL("../src/index.ts", import.meta.url))],
	});
	t.after(async () => {
		await client.stop();
		await provider.close();
		await rm(directory, { recursive: true, force: true });
	});
	await writeFile(join(directory, "settings.json"), JSON.stringify({
		cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(join(directory, "models.json"), JSON.stringify({ providers: {
		"rpc-test": {
			baseUrl: provider.baseUrls["openai-completions"], api: "openai-completions", apiKey: "local-test-key",
			models: [{ id: "test", contextWindow: 100_000, maxTokens: 128, reasoning: false, input: ["text"] }],
		},
	} }));
	const notifications: Array<{ message: string; type: unknown }> = [];
	client.onEvent((event: unknown) => {
		if (typeof event !== "object" || event === null || !("type" in event)) return;
		if (event.type !== "extension_ui_request" || !("method" in event) || event.method !== "notify") return;
		if ("message" in event && typeof event.message === "string") {
			notifications.push({ message: event.message, type: "notifyType" in event ? event.notifyType : undefined });
		}
	});
	await client.start();
	await client.getState();

	assert.equal(await client.prompt("/context"), "handled");
	assert.equal(notifications.at(-1)?.type, "info");
	assert.match(notifications.at(-1)?.message ?? "", /Context usage/);
	assert.equal(provider.requests.length, 0, "a cold inspection's silent probe must not reach the provider");

	const privateText = "PRIVATE_RPC_CONTEXT_CONTENT";
	await client.promptAndWait(privateText);
	assert.equal(provider.requests.length, 1);
	const before = await client.getEntries();
	for (const command of ["/context usage", "/context injections"]) {
		notifications.length = 0;
		assert.equal(await client.prompt(command), "handled");
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].type, "info");
		assert.doesNotMatch(notifications[0].message, /PRIVATE_RPC_(CONTEXT|PROMPT)_CONTENT|TUI mode only/);
		assert.match(notifications[0].message, /tokens/i);
		if (command === "/context usage") {
			assert.match(notifications[0].message, /Reported: 11 \/ 100,000 tokens/);
			assert.match(notifications[0].message, /System Prompt: [\d,]+/);
		} else {
			assert.match(notifications[0].message, /Payload comparison: complete/);
		}
	}
	assert.equal(provider.requests.length, 1, "inspection must not make another model request");
	assert.deepEqual(await client.getEntries(), before, "reports must not become session or model messages");

	// A missing capture with probing disabled still gives an explicitly marked estimate.
	await mkdir(join(directory, "extensions"), { recursive: true });
	await writeFile(join(directory, "extensions", "pi-context-view.json"), JSON.stringify({ autoProbing: false }));
	await client.newSession();
	notifications.length = 0;
	await client.prompt("/context usage");
	assert.equal(notifications.at(-1)?.type, "info");
	assert.match(notifications.at(-1)?.message ?? "", /probing.*disabled/i);
	assert.equal(provider.requests.length, 1);
});
