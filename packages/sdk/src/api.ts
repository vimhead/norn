import type { CreateAgentSessionOptions, EventBus, PromptOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type StaticDecode, type StaticEncode, type TCodec, type TSchema } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { createWorkflowTransition } from "@vimhead.dev/norn-core/workflow-transition";
import { Value } from "typebox/value";
import { assertWorkflowMetadata, isPlainObject, jsonValueSchema } from "./schema.ts";

const WORKFLOW_DECLARATION_KIND = "norn.workflow";

export type MaybePromise<T> = T | Promise<T>;
export type NornDispose = () => void;

export type NornWorkflowAnyGate = {
	readonly enabled: true;
	readonly fields?: readonly string[];
};

export type NornWorkflowPaths = {
	/** Absolute project root. Excluded from run checkpoints and rollback. */
	readonly project: string;

	/** Absolute, initially empty workspace. Saved in run checkpoints and restored on rollback. */
	readonly workspace: string;
};

export type NornWorkflowDeclaration<
	Id extends string = string,
	ArgsSchema extends TSchema = TSchema,
	ConfigSchema extends TSchema | undefined = TSchema | undefined,
	Scope extends NornWorkflowScopeInfo | undefined = NornWorkflowScopeInfo | undefined,
> = {
	(args: StaticEncode<ArgsSchema>): NornRunNext;
	readonly kind: typeof WORKFLOW_DECLARATION_KIND;
	readonly id: Id;
	readonly isEntrypoint: boolean;
	readonly instructions?: string;
	readonly args: ArgsSchema;
	readonly gate?: NornWorkflowGate<ArgsSchema> & {
		describe?(context: NornWorkflowContext<ArgsSchema, ConfigSchema, Scope>): MaybePromise<string>;
	};
	readonly config?: ConfigSchema;
	readonly scope: Scope;
	execute(context: NornWorkflowContext<ArgsSchema, ConfigSchema, Scope>): MaybePromise<WorkflowResult>;
};

export type NornAnyWorkflowDeclaration = Pick<NornWorkflowDeclaration, keyof NornWorkflowDeclaration> & ((args: never) => NornRunNext);
export type NornWorkflowRefSchemaOptions<ArgsSchema extends TSchema = TSchema> = {
	readonly args?: ArgsSchema;
};
export type NornWorkflowRefInput = StaticEncode<typeof workflowReferenceInputSchema>;
export type NornWorkflowRefOutput<ArgsSchema extends TSchema> = (args: StaticEncode<ArgsSchema> & object) => NornRunNext;

export type NornWorkflowArgsInput<TWorkflow extends NornAnyWorkflowDeclaration> = StaticEncode<TWorkflow["args"]>;
export type NornWorkflowArgs<TWorkflow extends NornAnyWorkflowDeclaration> = StaticDecode<TWorkflow["args"]>;

export type NornWorkflowGate<ArgsSchema extends TSchema> = unknown extends StaticEncode<ArgsSchema>
	? NornWorkflowAnyGate
	: StaticEncode<ArgsSchema> extends Record<string, unknown>
		? {
			readonly enabled: true;
			readonly fields?: readonly Extract<keyof StaticEncode<ArgsSchema>, string>[];
		}
		: {
			readonly enabled: true;
			readonly fields?: never;
		};

type NornWorkflowInstructions =
	| { readonly isEntrypoint: true; readonly instructions: string }
	| { readonly isEntrypoint: false; readonly instructions?: string };

type WorkflowConfig<Schema extends TSchema | undefined> = Schema extends TSchema ? StaticDecode<Schema> : undefined;

export type NornWorkflowContext<
	ArgsSchema extends TSchema = TSchema,
	ConfigSchema extends TSchema | undefined = TSchema | undefined,
	Scope extends NornWorkflowScopeInfo | undefined = NornWorkflowScopeInfo | undefined,
> = {
	readonly args: StaticDecode<ArgsSchema>;
	readonly config: WorkflowConfig<ConfigSchema>;
	readonly paths: NornWorkflowPaths;
	readonly run: NornRun;
} & (Scope extends NornWorkflowScopeInfo ? {
	readonly scope: { readonly id: Scope["id"]; readonly config: WorkflowConfig<Scope["config"]> };
} : {});

export type NornWorkflowDefinition<
	Id extends string = string,
	ArgsSchema extends TSchema = TSchema,
	ConfigSchema extends TSchema | undefined = undefined,
	Scope extends NornWorkflowScopeInfo | undefined = undefined,
> = {
	readonly id: Id;
	readonly args: ArgsSchema;
	readonly config?: ConfigSchema;
	readonly gate?: NornWorkflowGate<ArgsSchema> & {
		describe?(context: NornWorkflowContext<ArgsSchema, ConfigSchema, Scope>): MaybePromise<string>;
	};
	execute(context: NornWorkflowContext<ArgsSchema, ConfigSchema, Scope>): MaybePromise<WorkflowResult>;
} & NornWorkflowInstructions;

export type NornWorkflowScopeInfo = {
	readonly id: string;
	readonly config?: TSchema;
};

export type NornWorkflowScope<Id extends string, ConfigSchema extends TSchema | undefined> = {
	readonly id: Id;
	readonly config: ConfigSchema;
	workflow<const LocalId extends string, ArgsSchema extends TSchema, LocalConfig extends TSchema | undefined = undefined>(
		definition: NornWorkflowDefinition<LocalId, ArgsSchema, LocalConfig, { readonly id: Id; readonly config: ConfigSchema }>,
	): NornWorkflowDeclaration<`${Id}.${LocalId}`, ArgsSchema, LocalConfig, { readonly id: Id; readonly config: ConfigSchema }>;
};

export function workflow<
	const Id extends string,
	ArgsSchema extends TSchema,
	ConfigSchema extends TSchema | undefined = undefined,
>(definition: NornWorkflowDefinition<Id, ArgsSchema, ConfigSchema>): NornWorkflowDeclaration<Id, ArgsSchema, ConfigSchema, undefined> {
	return createWorkflow({ definition, scope: undefined });
}

function createWorkflow<Id extends string, ArgsSchema extends TSchema, ConfigSchema extends TSchema | undefined, Scope extends NornWorkflowScopeInfo | undefined>(
	input: { readonly definition: NornWorkflowDefinition<Id, ArgsSchema, ConfigSchema, Scope>; readonly scope: Scope },
): NornWorkflowDeclaration<Id, ArgsSchema, ConfigSchema, Scope> {
	const { definition, scope } = input;
	assertDeclarationId(definition.id);
	const callable = (args: StaticEncode<ArgsSchema>): NornRunNext => createWorkflowTransition({ workflowId: definition.id, args });
	const result = Object.assign(callable, definition, {
		kind: WORKFLOW_DECLARATION_KIND,
		scope,
	}) as NornWorkflowDeclaration<Id, ArgsSchema, ConfigSchema, Scope>;
	if (!isWorkflowDeclaration(result)) throw new Error(`Invalid workflow definition: ${definition.id}`);
	assertWorkflowMetadata(result);
	return result;
}

export function workflowScope<const Id extends string, ConfigSchema extends TSchema | undefined = undefined>(
	input: { readonly id: Id; readonly config?: ConfigSchema },
): NornWorkflowScope<Id, ConfigSchema> {
	assertDeclarationId(input.id);
	const scope = { id: input.id, config: input.config as ConfigSchema };
	return {
		id: input.id,
		config: input.config as ConfigSchema,
		workflow(definition) {
			assertDeclarationId(definition.id);
			return createWorkflow({ definition: { ...definition, id: `${input.id}.${definition.id}` }, scope });
		},
	};
}

export type NornRunNext = {
	readonly type: "next";
	readonly workflowId: string;
	readonly args: unknown;
};

export type NornRunOutcomeMetadata = {
	readonly summary?: string;
	readonly logs?: Record<string, NornLogRef>;
	readonly data?: Record<string, unknown>;
};

export type NornRunComplete = {
	readonly type: "complete";
	readonly metadata?: NornRunOutcomeMetadata;
};

export type NornRunFail = {
	readonly type: "fail";
	readonly metadata: NornRunOutcomeMetadata & { readonly summary: string };
};

export type WorkflowResult = NornRunNext | NornRunComplete | NornRunFail;

export type NornRunStartOptions = {
	readonly id?: string;
	readonly name?: string;
	readonly configOverride?: unknown;
};

export type NornStartedRunResult = {
	readonly status: "running";
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
};

export type NornCompletedRunResult = {
	readonly status: "completed";
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
	readonly metadata?: NornRunOutcomeMetadata;
};

export type NornFailedRunResult = {
	readonly status: "failed";
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
	readonly metadata: NornRunOutcomeMetadata & { readonly summary: string };
};

export type NornStoppedRunResult = {
	readonly status: "stopped";
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
};

export type NornRunInterruption = {
	readonly workflowId: string;
	readonly args: unknown;
	readonly description: string;
	readonly fields?: readonly string[];
};

export type NornInterruptedRunResult = {
	readonly status: "interrupted";
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
	readonly interruption: NornRunInterruption;
};

export type NornRunResult = NornStartedRunResult | NornCompletedRunResult | NornFailedRunResult | NornStoppedRunResult | NornInterruptedRunResult;

export type NornRunStatus = "running" | "interrupted" | "stopped" | "pendingResume" | "completed" | "failed";
export type NornRunHealth = "healthy" | "unhealthy";

export type NornRunOutcomeInfo = {
	readonly workflowId: string;
	readonly completedAt: string;
	readonly status: "completed" | "failed";
	readonly metadata?: NornRunOutcomeMetadata;
};

export type NornRunFailureInfo = {
	readonly workflowId: string;
	readonly error: string;
	readonly metadata?: NornRunOutcomeMetadata;
	readonly failedAt: string;
};

export type NornRunInfo = {
	readonly version: number;
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly paths: NornWorkflowPaths;
	readonly entrypointWorkflowId: string;
	readonly currentWorkflowId?: string;
	readonly status: NornRunStatus;
	readonly health: NornRunHealth;
	readonly interruption?: NornRunInterruption;
	readonly outcome?: NornRunOutcomeInfo;
	readonly failed?: NornRunFailureInfo;
	readonly startedAt: string;
	readonly updatedAt: string;
};

export type DeletedNornRunInfo = {
	readonly id: string;
	readonly name: string;
	readonly path: string;
};

export type NornRunCheckpoint = {
	readonly id: string;
	readonly path: string;
	readonly index: number;
	readonly message: string;
	readonly createdAt: string;
};

export type NornCommandRunInput = {
	readonly label: string;
	readonly command: string | readonly [string, ...string[]];
	readonly cwd: string;
	readonly env?: Record<string, string>;
	readonly timeoutMs?: number;
};

const emptyWorkflowRefArgsSchema = Type.Object({});
const workflowReferenceInputSchema = Type.Union([
	Type.String({ minLength: 1 }),
	Type.Object({ workflow: Type.String({ minLength: 1 }), forwardArgs: Type.Record(Type.String(), Type.Unknown()) }),
]);

export function workflowRefSchema<ArgsSchema extends TSchema = typeof emptyWorkflowRefArgsSchema>(options?: NornWorkflowRefSchemaOptions<ArgsSchema>): TCodec<typeof workflowReferenceInputSchema, NornWorkflowRefOutput<ArgsSchema>> {
	const contributionSchema = options?.args ?? emptyWorkflowRefArgsSchema;
	return Type.With(Type.Decode(workflowReferenceInputSchema, reference => {
		const workflowId = typeof reference === "string" ? reference : reference.workflow;
		const forwardArgs = typeof reference === "string" ? {} : reference.forwardArgs;
		return (args: StaticEncode<ArgsSchema> & object): NornRunNext => {
			Value.Assert(contributionSchema, args);
			if (!isPlainObject(args)) throw new Error("Workflow reference contributions must be objects");
			Value.Assert(jsonValueSchema, args);
			return createWorkflowTransition({ workflowId, args: { ...forwardArgs, ...args } });
		};
	}), { "x-norn-workflow-ref": { contributedArgsSchema: contributionSchema } });
}

export type NornLogRef = {
	readonly id: string;
};

export type NornCommandRunResult = {
	readonly label: string;
	readonly command: string | readonly [string, ...string[]];
	readonly cwd: string;
	readonly exitCode: number | null;
	readonly stdoutTail: string;
	readonly stderrTail: string;
	readonly killed: boolean;
	readonly stdoutLog: NornLogRef;
	readonly stderrLog: NornLogRef;
};

export type NornAgentBeforeSessionStartContext = {
	readonly events: EventBus;
};

export type NornAgentCreateSessionInput = {
	readonly customTools?: readonly ToolDefinition[];
	readonly label: string;
	readonly cwd: string;
	readonly tools?: string[];
	readonly beforeSessionStart?: (context: NornAgentBeforeSessionStartContext) => MaybePromise<void>;
	readonly model?: CreateAgentSessionOptions["model"];
	readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	readonly systemPrompt?: string;
	readonly appendSystemPrompt?: readonly string[];
};

export type NornAgentPromptInput<ResponseSchema extends TSchema> = {
	readonly prompt: string;
	readonly response: ResponseSchema;
	readonly maxAttempts?: number;
	readonly options?: PromptOptions;
};

export type NornAgentSinglePromptInput<ResponseSchema extends TSchema> = NornAgentCreateSessionInput & NornAgentPromptInput<ResponseSchema>;

export type NornAgentSessionEvents = EventBus;

export type NornAgentUsageCost = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
};

export type NornAgentUsage = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning?: number;
	readonly totalTokens: number;
	readonly cost: NornAgentUsageCost;
};

export type NornAgentMetrics = {
	readonly index: number;
	readonly label: string;
	readonly status: "running" | "completed" | "failed";
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly wallMs: number;
	readonly attempts?: number;
	readonly usage: NornAgentUsage;
};

export type NornCommandMetrics = {
	readonly index: number;
	readonly label: string;
	readonly status: "running" | "completed" | "failed";
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly wallMs: number;
	readonly exitCode?: number | null;
	readonly killed?: boolean;
};

export type NornWorkflowMetrics = {
	readonly index: number;
	readonly workflowId: string;
	readonly status: "running" | "completed" | "failed" | "transitioned";
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly wallMs: number;
	readonly ownMs: number;
	readonly agentsMs: number;
	readonly commandsMs: number;
	readonly agentUsage: NornAgentUsage;
	readonly agents: readonly NornAgentMetrics[];
	readonly commands: readonly NornCommandMetrics[];
};

export type NornRunMetrics = {
	readonly status: NornRunStatus;
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly wallMs: number;
	readonly activeMs: number;
	readonly gateWaitMs: number;
	readonly workflowsMs: number;
	readonly workflowOwnMs: number;
	readonly agentsMs: number;
	readonly commandsMs: number;
	readonly agentUsage: NornAgentUsage;
	readonly workflows: readonly NornWorkflowMetrics[];
};

export type NornAgentRunRawAttempt = {
	readonly attempt: number;
	readonly text: string;
	readonly messages: unknown[];
	readonly responseToolCalled: boolean;
	readonly usage: NornAgentUsage;
	readonly toolResponse?: unknown;
	readonly sessionFile?: string;
	readonly error?: string;
};

export type NornAgentRunResult<ResponseSchema extends TSchema> = {
	readonly label: string;
	readonly cwd: string;
	readonly response: StaticDecode<ResponseSchema>;
	readonly usage: NornAgentUsage;
	readonly raw: {
		readonly text: string;
		readonly messages: unknown[];
		readonly responseToolCalled: boolean;
		readonly usage: NornAgentUsage;
		readonly toolResponse?: unknown;
		readonly sessionFile?: string;
		readonly attempts: readonly NornAgentRunRawAttempt[];
	};
};

export type NornAgentSession = {
	readonly label: string;
	readonly cwd: string;
	readonly events: NornAgentSessionEvents;
	prompt<ResponseSchema extends TSchema>(input: NornAgentPromptInput<ResponseSchema>): Promise<StaticDecode<ResponseSchema>>;
	dispose(): Promise<void>;
};

export type NornRun = {
	id: string;
	next(workflowId: string, args: unknown): NornRunNext;
	complete(metadata?: NornRunOutcomeMetadata): NornRunComplete;
	fail(metadata: NornRunOutcomeMetadata & { readonly summary: string }): NornRunFail;
	resources: import("./resources.ts").NornResources;
	logs: {
		read(log: NornLogRef): Promise<string>;
	};
	commands: {
		run(input: NornCommandRunInput): Promise<NornCommandRunResult>;
	};
	agents: {
		createSession(input: NornAgentCreateSessionInput): Promise<NornAgentSession>;
		prompt<ResponseSchema extends TSchema>(input: NornAgentSinglePromptInput<ResponseSchema>): Promise<StaticDecode<ResponseSchema>>;
	};
};

export type NornWorkflowSource = {
	readonly path: string;
	readonly configPath: string;
};

export type NornJsonSchema = Record<string, unknown>;

export type NornWorkflowGateInfo = {
	readonly enabled: true;
	readonly fields?: readonly string[];
};

export type NornRegisteredWorkflowInfo = {
	readonly id: string;
	readonly instructions?: string;
	readonly isEntrypoint: boolean;
	readonly scope?: { readonly id: string };
	readonly source?: NornWorkflowSource;
	readonly configKey: string;
};

export type NornInspectedWorkflowInfo = NornRegisteredWorkflowInfo & {
	readonly scope?: { readonly id: string; readonly configKey: string; readonly configSchema: NornJsonSchema | null };
	readonly argsSchema: NornJsonSchema;
	readonly configSchema: NornJsonSchema | null;
	readonly gate: NornWorkflowGateInfo | null;
};

export type NornWorkflowDiagnostic = {
	readonly configPath: string;
	readonly modulePath: string;
	readonly scopeId: string | null;
	readonly workflowId: string | null;
	readonly stage: "import" | "declaration" | "config" | "duplicate" | "schema";
	readonly message: string;
	readonly issues: readonly TLocalizedValidationError[];
};

export type NornProjectLoadStatus = {
	readonly isComplete: boolean;
	readonly diagnostics: readonly NornWorkflowDiagnostic[];
};

export type NornWorkflowCatalogInfo = NornProjectLoadStatus & {
	readonly workflows: readonly NornRegisteredWorkflowInfo[];
};

export type NornWorkflowInspection = NornProjectLoadStatus & {
	readonly workflow: NornInspectedWorkflowInfo | null;
};

export type NornProjectInspection = NornProjectLoadStatus & {
	readonly project: NornProjectInfo;
};

export type NornProjectConfigurationInfo = {
	readonly key: string;
	readonly scopeId: string | null;
	readonly configSchema: NornJsonSchema | null;
	readonly config: unknown;
};

export type NornProjectInfo = {
	readonly cwd: string;
	readonly projectPath: string;
	readonly projectRoot: string;
	readonly configPath: string;
	readonly configRoot: string;
	readonly configFiles: readonly string[];
	readonly configurations: readonly NornProjectConfigurationInfo[];
	readonly modules: readonly NornWorkflowSource[];
};

function assertDeclarationId(id: string): void {
	if (typeof id !== "string" || id.trim().length === 0 || id.split(".").some(segment => segment.length === 0)) throw new Error(`Invalid workflow or scope id: ${id}`);
}

export function isWorkflowDeclaration(value: unknown): value is NornAnyWorkflowDeclaration {
	if (typeof value !== "function") return false;
	const candidate = value as { kind?: unknown; id?: unknown; instructions?: unknown; isEntrypoint?: unknown; args?: unknown; execute?: unknown };
	return (
		candidate.kind === WORKFLOW_DECLARATION_KIND &&
		typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		(candidate.instructions === undefined || typeof candidate.instructions === "string") &&
		typeof candidate.isEntrypoint === "boolean" &&
		Boolean(candidate.args) &&
		typeof candidate.execute === "function"
	);
}

export function isWorkflowNext(value: unknown): value is NornRunNext {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { type?: unknown; workflowId?: unknown; args?: unknown };
	return candidate.type === "next" && typeof candidate.workflowId === "string" && candidate.workflowId.length > 0;
}

export function isWorkflowComplete(value: unknown): value is NornRunComplete {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { type?: unknown };
	return candidate.type === "complete";
}

export function isWorkflowFail(value: unknown): value is NornRunFail {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { type?: unknown; metadata?: { summary?: unknown } };
	return candidate.type === "fail" && typeof candidate.metadata?.summary === "string" && candidate.metadata.summary.length > 0;
}
