import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { NornRunOutcomeMetadata, NornRun } from "@vimhead.dev/norn";
import { createWorkflowTransition } from "@vimhead.dev/norn-core/workflow-transition";
import type { NornAgentResponseCollector } from "./agent-response-tool.ts";
import { NornAgentRunner } from "./agents.ts";
import { NornCommandRunner } from "./commands.ts";
import type { NornRunLogs } from "./logs.ts";
import type { NornRunLogger } from "./run-log.ts";

type DefaultNornRunInput = {
	readonly id: string;
	readonly runRoot: string;
	readonly signal?: AbortSignal;
	readonly model?: CreateAgentSessionOptions["model"];
	readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	readonly agentDir?: string;
	readonly responseCollector: NornAgentResponseCollector;
	readonly logger: NornRunLogger;
	readonly logs: NornRunLogs;
};

export class NornRunContext implements NornRun {
	readonly logs: NornRun["logs"];
	readonly commands: NornRun["commands"];
	readonly agents: NornRun["agents"];
	readonly id: string;

	constructor(private readonly input: DefaultNornRunInput) {
		this.id = input.id;
		this.logs = {
			read: (log) => this.input.logs.read(log),
		};
		this.commands = {
			run: (commandInput) =>
				new NornCommandRunner({
					signal: this.input.signal,
					logs: this.input.logs,
					logger: this.input.logger,
				}).run(commandInput),
		};
		this.agents = {
			createSession: (agentInput) => this.createAgentRunner().createSession(agentInput),
			prompt: (agentInput) => this.createAgentRunner().prompt(agentInput),
		};
	}

	private createAgentRunner(): NornAgentRunner {
		return new NornAgentRunner({
			id: this.id,
			runRoot: this.input.runRoot,
			signal: this.input.signal,
			model: this.input.model,
			thinkingLevel: this.input.thinkingLevel,
			agentDir: this.input.agentDir,
			logs: this.input.logs,
			logger: this.input.logger,
			responseCollector: this.input.responseCollector,
		});
	}

	next(workflowId: string, args: unknown): ReturnType<NornRun["next"]> {
		return createWorkflowTransition({ workflowId, args });
	}

	complete(metadata?: NornRunOutcomeMetadata): ReturnType<NornRun["complete"]> {
		return { type: "complete", metadata };
	}

	fail(metadata: NornRunOutcomeMetadata & { readonly summary: string }): ReturnType<NornRun["fail"]> {
		return { type: "fail", metadata };
	}
}
