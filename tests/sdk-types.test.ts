import type {
	CreateAgentSessionOptions as PiCreateAgentSessionOptions,
	EventBus as PiEventBus,
	PromptOptions as PiPromptOptions,
	ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
	CreateAgentSessionOptions,
	EventBus,
	PromptOptions,
	ToolDefinition,
} from "@vimhead.dev/norn";
import { expectTypeOf, test } from "vitest";

test("SDK consumers can import original Pi authoring types through Norn", () => {
	expectTypeOf<CreateAgentSessionOptions>().toEqualTypeOf<PiCreateAgentSessionOptions>();
	expectTypeOf<EventBus>().toEqualTypeOf<PiEventBus>();
	expectTypeOf<PromptOptions>().toEqualTypeOf<PiPromptOptions>();
	expectTypeOf<ToolDefinition>().toEqualTypeOf<PiToolDefinition>();
});
