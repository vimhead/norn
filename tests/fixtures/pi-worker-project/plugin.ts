import { workflow, workflowScope } from "@vimhead.dev/norn";
import { Type } from "typebox";

const manifestScope = workflowScope({ id: "provider" });
const manifest_check = manifestScope.workflow({
id: "check",
isEntrypoint: true,
instructions: "Exercise a configured provider in a native worker.",
args: Type.Object({}),
async execute({ run: run }) {
				const result = await run.agents.prompt({ label: "check", tools: [], prompt: "Return ok", response: Type.Object({ ok: Type.Boolean() }), maxAttempts: 1 });
				const artifact = await run.artifacts.write("result.json", JSON.stringify(result));
				return run.complete({ artifacts: { result: artifact } });
			}
});

export default [manifest_check];
