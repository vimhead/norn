import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { NornAgents, NornCommands, NornLogs, NornRun } from "@vimhead.dev/norn";
import { createWorkflowTransition } from "@vimhead.dev/norn-core/workflow-transition";
import type { NornAgentResponseCollector } from "./agent-response-tool.ts";
import { NornAgentRunner } from "./agents.ts";
import { NornCommandRunner } from "./commands.ts";
import type { NornRunLogs } from "./logs.ts";
import type { NornRunLogger } from "./run-log.ts";

type NornExecutionContextInput = {
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

export class NornExecutionContext {
	readonly run: NornRun;
	readonly logs: NornLogs;
	readonly commands: NornCommands;
	readonly agents: NornAgents;

	constructor(private readonly input: NornExecutionContextInput) {
		this.run = {
			id: input.id,
			next: (workflowId, args) => createWorkflowTransition({ workflowId, args }),
			complete: metadata => ({ type: "complete", metadata }),
			fail: metadata => ({ type: "fail", metadata }),
		};
		this.logs = {
			read: log => this.input.logs.read(log),
		};
		this.commands = {
			run: commandInput => new NornCommandRunner({
				signal: this.input.signal,
				logs: this.input.logs,
				logger: this.input.logger,
			}).run(commandInput),
		};
		this.agents = {
			createSession: agentInput => this.createAgentRunner().createSession(agentInput),
			prompt: agentInput => this.createAgentRunner().prompt(agentInput),
		};
	}

	private createAgentRunner(): NornAgentRunner {
		return new NornAgentRunner({
			id: this.input.id,
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
}
