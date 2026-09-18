import { writeJsonAtomically } from "@vimhead.dev/norn-core/atomic-files";
import { createRunFileCoordinator } from "@vimhead.dev/norn/files";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { initializeRunResources } from "../../packages/cli/src/internal/run-resources.ts";

const [root, mode, worker] = process.argv.slice(2);
const files = createRunFileCoordinator(root);
const target = join(root, "counter.json");
if (mode === "hold") {
	await files.withExclusiveLock(target, async () => {
		process.stdout.write("locked\n");
		await delay(60_000);
	});
} else if (mode === "counter") {
	for (let index = 0; index < 12; index++) {
		await files.withExclusiveLock(target, async (path) => {
			const previous = JSON.parse(await readFile(path, "utf8"));
			await delay(1);
			await writeJsonAtomically(path, previous + 1);
		});
	}
} else if (mode === "state") {
	const { state } = await initializeRunResources(root);
	for (let index = 0; index < 12; index++) {
		await state.set({ id: `${worker}-${index}`, schema: Type.Number() }, index);
	}
} else {
	throw new Error(`Unknown lock worker mode: ${mode}`);
}
