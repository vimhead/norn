import assert from "node:assert/strict";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export default async function checkCodexOAuthLogin(): Promise<void> {
	const oauth = builtinProviders().find(
		(provider) => provider.id === "openai-codex",
	)?.auth?.oauth;
	assert.ok(oauth);
	const cancelled = new Error("Stop the OAuth probe before authorization");
	await assert.rejects(
		oauth.login({
			signal: new AbortController().signal,
			async prompt(request) {
				assert.ok(request.type === "select");
				assert.deepEqual(
					request.options.map((option) => option.id),
					["browser", "device_code"],
				);
				throw cancelled;
			},
			notify() {
				assert.fail("OAuth probe must stop before authorization");
			},
		}),
		(error) => {
			if (error !== cancelled) console.error(error);
			return error === cancelled;
		},
	);
	console.log("Codex OAuth login reached method selection");
}
