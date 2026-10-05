import type {
	CreateAgentSessionOptions as PiCreateAgentSessionOptions,
	EventBus as PiEventBus,
	PromptOptions as PiPromptOptions,
	ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
	CreateAgentSessionOptions,
	EventBus,
	NornAgents,
	PromptOptions,
	ToolDefinition,
} from "@vimhead.dev/norn";
import { expectTypeOf, test } from "vitest";

function verifyAgentModels(agents: NornAgents) {
	const base = { label: "review", cwd: "/workspace" };
	agents.createSession({
		...base,
		models: [{ provider: "team", id: "review" }],
	});
	agents.createSession({
		...base,
		models: [
			{ provider: "preferred", id: "review" },
			{ provider: "fallback", id: "review" },
		],
	});
	// @ts-expect-error Agent model references are required.
	agents.createSession(base);
	// @ts-expect-error Models must contain at least one reference.
	agents.createSession({ ...base, models: [] });
	// @ts-expect-error Each model reference requires provider and id.
	agents.createSession({ ...base, models: [{ provider: "team" }] });
}
void verifyAgentModels;

test("SDK consumers can import original Pi authoring types through Norn", () => {
	expectTypeOf<CreateAgentSessionOptions>().toEqualTypeOf<PiCreateAgentSessionOptions>();
	expectTypeOf<EventBus>().toEqualTypeOf<PiEventBus>();
	expectTypeOf<PromptOptions>().toEqualTypeOf<PiPromptOptions>();
	expectTypeOf<ToolDefinition>().toEqualTypeOf<PiToolDefinition>();
});
