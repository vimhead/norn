import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow, workflowScope } from "@vimhead.dev/norn";
import { Type } from "typebox";

const manifestScope = workflowScope({ id: "provider" });
const manifest_check = manifestScope.workflow({
id: "check",
isEntrypoint: true,
instructions: "Exercise a configured provider in a native worker.",
args: Type.Object({}),
async execute({ paths, agents, run }) {
				const result = await agents.prompt({ label: "check", cwd: paths.workspace, tools: [], prompt: "Return ok", response: Type.Object({ ok: Type.Boolean() }), maxAttempts: 1 });
				const resultPath = "result.json";
				await writeFile(join(paths.workspace, resultPath), JSON.stringify(result));
				return run.complete({ data: { resultPath } });
			}
});

export default [manifest_check];
