import type {
	NornRunInfo,
	NornRunPruneOptions,
	NornRunPruneResult,
} from "@vimhead.dev/norn";
import { errorMessage } from "./errors.ts";
import { getRunLeaseOwner, NornRunLease } from "./run-lease.ts";
import { getRunInfo, listRuns } from "./run-state.ts";
import { NornRunStore } from "./run-store.ts";

const DURATION_UNITS: Readonly<Record<string, number>> = {
	ms: 1,
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
};

export function parseRunPruneOptions(
	args: readonly string[],
): NornRunPruneOptions {
	const flags = new Set<string>();
	let olderThan: string | null = null;
	for (let index = 0; index < args.length; index++) {
		const flag = args[index];
		if (!["--delete-runs", "--all", "--dry-run", "--older-than"].includes(flag))
			throw new Error(`runs prune: unknown argument ${flag}`);
		if (flags.has(flag))
			throw new Error(`runs prune: duplicate option ${flag}`);
		flags.add(flag);
		if (flag === "--older-than") {
			const value = args[++index];
			if (value === undefined || value.startsWith("--"))
				throw new Error(
					"runs prune: --older-than requires a duration such as 24h or 7d",
				);
			olderThan = value;
		}
	}
	return {
		deleteRuns: flags.has("--delete-runs"),
		all: flags.has("--all"),
		olderThan,
		dryRun: flags.has("--dry-run"),
	};
}

function parsePruneDuration(value: string): number {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(value);
	const duration = match ? Number(match[1]) * DURATION_UNITS[match[2]] : NaN;
	if (
		!Number.isFinite(duration) ||
		duration < 0 ||
		duration > Number.MAX_SAFE_INTEGER
	)
		throw new Error(
			`runs prune: invalid duration ${value}; use a non-negative number followed by ms, s, m, h, d, or w`,
		);
	return duration;
}

export class NornRunPruner {
	private readonly olderThan: string | null;
	private readonly cutoff: number | null;

	constructor(
		private readonly input: {
			readonly projectRoot: string;
			readonly options: NornRunPruneOptions;
			readonly now: Date;
		},
	) {
		if (input.options.all && !input.options.deleteRuns)
			throw new Error("runs prune: --all requires --delete-runs");
		if (input.options.all && input.options.olderThan !== null)
			throw new Error(
				"runs prune: --all and --older-than are mutually exclusive",
			);
		if (!Number.isFinite(input.now.getTime()))
			throw new Error("Invalid pruning time");
		this.olderThan = input.options.all
			? null
			: (input.options.olderThan ?? "24h");
		this.cutoff =
			this.olderThan === null
				? null
				: input.now.getTime() - parsePruneDuration(this.olderThan);
	}

	async prune(): Promise<NornRunPruneResult> {
		const results: NornRunPruneResult["runs"][number][] = [];
		for (const run of await listRuns(this.input.projectRoot)) {
			const identity = { id: run.id, name: run.name, path: run.path };
			let lease: NornRunLease | undefined;
			try {
				let reason = this.findIneligibilityReason(run);
				if (!reason && (await getRunLeaseOwner(run.path)))
					reason = "Run is owned by an executor";
				if (reason) {
					results.push({ ...identity, status: "skipped", reason });
					continue;
				}
				if (this.input.options.dryRun) {
					results.push({ ...identity, status: "planned" });
					continue;
				}
				try {
					lease = await NornRunLease.acquire(run.path);
				} catch (error) {
					if (
						error instanceof Error &&
						error.message.startsWith("Run is already active:")
					) {
						results.push({
							...identity,
							status: "skipped",
							reason: "Run is owned by an executor",
						});
						continue;
					}
					throw error;
				}
				reason = this.findIneligibilityReason(await getRunInfo(run.path));
				if (reason) {
					results.push({ ...identity, status: "skipped", reason });
					continue;
				}
				await lease.assertOwned();
				if (this.input.options.deleteRuns) {
					await lease.deleteRunDirectory();
				} else {
					const store = await NornRunStore.open(run.path);
					await store.pruneCheckpointHistory(this.input.now.toISOString());
				}
				results.push({ ...identity, status: "pruned" });
			} catch (error) {
				results.push({
					...identity,
					status: "failed",
					reason: errorMessage(error),
				});
			} finally {
				await lease?.release();
			}
		}
		return {
			mode: this.input.options.deleteRuns ? "runs" : "checkpoints",
			dryRun: this.input.options.dryRun,
			olderThan: this.olderThan,
			runs: results,
		};
	}

	private findIneligibilityReason(run: NornRunInfo): string | undefined {
		if (run.status !== "completed" && run.status !== "failed")
			return `Run status is ${run.status}; only completed or failed runs are eligible`;
		const finishedAt =
			run.status === "failed"
				? (run.failed?.failedAt ?? run.outcome?.completedAt ?? run.updatedAt)
				: (run.outcome?.completedAt ?? run.updatedAt);
		const finishedTime = Date.parse(finishedAt);
		if (!Number.isFinite(finishedTime))
			return "Run completion/failure time is invalid";
		if (this.cutoff !== null && finishedTime >= this.cutoff)
			return `Run finished less than or exactly ${this.olderThan} ago`;
		return undefined;
	}
}
