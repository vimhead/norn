import { join } from "node:path";
import type { NornRun, NornWorkflowPaths } from "@vimhead.dev/norn";
import { ensureCommandSucceeded } from "../../shared/commands.ts";

const WORKSPACE_REPOSITORY_PATH = "repo";

export async function materializeWorkspaceRepository({ run, paths, repositoryRoot, baseRef }: { run: NornRun; paths: NornWorkflowPaths; repositoryRoot: string; baseRef: string }): Promise<string> {
	const repositoryPath = join(paths.workspace, WORKSPACE_REPOSITORY_PATH);
	const result = await run.commands.run({
		label: "materialize-workspace-repository",
		cwd: paths.workspace,
		command: [
			`rm -rf ${shellQuote(repositoryPath)}`,
			`git clone --no-checkout ${shellQuote(repositoryRoot)} ${shellQuote(repositoryPath)}`,
			`git -C ${shellQuote(repositoryPath)} checkout ${shellQuote(baseRef)}`,
		].join(" && "),
	});
	await ensureCommandSucceeded(result);
	return WORKSPACE_REPOSITORY_PATH;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
