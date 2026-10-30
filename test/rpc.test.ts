import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { startMockProvider } from "./harness/mock-provider.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Split only on LF: raw previews may contain U+2028, which generic line readers split.
async function* jsonl(stream: Readable): AsyncGenerator<Record<string, unknown>> {
	stream.setEncoding("utf8");
	let buffer = "";
	for await (const chunk of stream) {
		buffer += chunk;
		let end: number;
		while ((end = buffer.indexOf("\n")) !== -1) {
			const value: unknown = JSON.parse(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
			assert.ok(isRecord(value));
			yield value;
		}
	}
}

// Exercise actual GUI-client JSONL dialogs, without user resources or credentials.
test("RPC context views support opt-in previews without provider requests or persisted edits", { timeout: 30_000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "context-rpc-"));
	const provider = await startMockProvider();
	await writeFile(join(directory, "settings.json"), JSON.stringify({
		cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(join(directory, "models.json"), JSON.stringify({ providers: {
		"rpc-test": {
			baseUrl: provider.baseUrls["openai-completions"], api: "openai-completions", apiKey: "local-test-key",
			models: [{ id: "test", contextWindow: 100_000, maxTokens: 128, reasoning: false, input: ["text"] }],
		},
	} }));
	const child = spawn(process.execPath, [
		fileURLToPath(new URL("bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))),
		"--mode", "rpc", "--provider", "rpc-test", "--model", "test",
		"--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
		"--append-system-prompt", "PRIVATE_RPC_PROMPT_CONTENT",
		"-e", fileURLToPath(new URL("../src/index.ts", import.meta.url)),
	], { cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1" },
		stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });
	const exited = once(child, "exit");
	child.stderr.resume();
	t.after(async () => {
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
		try { await exited; } finally { clearTimeout(timer); }
		await provider.close();
		await rm(directory, { recursive: true, force: true });
	});
	const records = jsonl(child.stdout);
	const events: Record<string, unknown>[] = [];
	const send = (value: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(value)}\n`);
	async function read() {
		const next = await records.next();
		assert.equal(next.done, false, "RPC exited before completing the command");
		assert.ok(next.value);
		events.push(next.value);
		return next.value;
	}
	let id = 0;
	async function request(command: Record<string, unknown>, onDialog?: (event: Record<string, unknown>) => Record<string, unknown>) {
		const requestId = String(++id);
		send({ ...command, id: requestId });
		for (;;) {
			const event = await read();
			if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(event.method))) {
				send({ type: "extension_ui_response", id: event.id, ...(onDialog?.(event) ?? { cancelled: true }) });
			}
			if (event.type === "response" && event.id === requestId) {
				assert.equal(event.success, true);
				return event.data;
			}
		}
	}
	const notifications = () => events.filter((event) => event.type === "extension_ui_request" && event.method === "notify");

	await request({ type: "get_state" });
	await request({ type: "prompt", message: "/context" });
	assert.equal(notifications().at(-1)?.notifyType, "info");
	assert.match(String(notifications().at(-1)?.message), /Context usage/);
	assert.equal(provider.requests.length, 0, "cold inspection's silent probe must not reach the provider");

	const privateText = "PRIVATE_RPC_CONTEXT_CONTENT\u2028second line";
	events.length = 0;
	await request({ type: "prompt", message: privateText });
	while (!events.some((event) => event.type === "agent_settled")) await read();
	assert.equal(provider.requests.length, 1);
	const before = await request({ type: "get_entries" });
	for (const command of ["/context usage", "/context injections"]) {
		events.length = 0;
		await request({ type: "prompt", message: command });
		assert.equal(notifications().length, 1);
		assert.equal(notifications()[0].notifyType, "info");
		assert.doesNotMatch(JSON.stringify(events), /PRIVATE_RPC_(CONTEXT|PROMPT)_CONTENT|TUI mode only/);
		if (command === "/context usage") {
			assert.match(String(notifications()[0].message), /Reported: 11 \/ 100,000 tokens/);
		} else {
			assert.match(String(notifications()[0].message), /Payload comparison: complete/);
		}
	}

	const choices = ["User Messages", "1. user", "Preview text (client may retain it)", "Close"];
	let previews = 0;
	await request({ type: "prompt", message: "/context usage" }, (event) => {
		if (event.method === "editor") {
			previews++;
			assert.equal(event.prefill, privateText);
			return { value: "USER_EDITS_MUST_NOT_REACH_MODEL" };
		}
		assert.equal(event.method, "select");
		assert.ok(Array.isArray(event.options));
		const desired = choices.shift();
		assert.ok(desired);
		const value: unknown = event.options.find((option: unknown) => typeof option === "string" && option.includes(desired));
		assert.equal(typeof value, "string");
		return { value };
	});
	assert.equal(previews, 1);
	assert.equal(choices.length, 0);
	assert.equal(provider.requests.length, 1, "browsing must not make another model request");
	assert.deepEqual(await request({ type: "get_entries" }), before, "previews and edits must not become session entries");

	// A missing capture with probing disabled still gives an explicitly marked estimate.
	await mkdir(join(directory, "extensions"), { recursive: true });
	await writeFile(join(directory, "extensions", "pi-context-view.json"), JSON.stringify({ autoProbing: false }));
	await request({ type: "new_session" });
	events.length = 0;
	await request({ type: "prompt", message: "/context usage" });
	assert.match(String(notifications().at(-1)?.message), /probing.*disabled/i);
	assert.equal(provider.requests.length, 1);
});
