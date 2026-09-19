import { writeJsonAtomically } from "@vimhead.dev/norn-core/atomic-files";
import { createRunFileCoordinator } from "../../packages/cli/src/internal/file-coordinator.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { initializeSharedState } from "../helpers/shared-state.ts";

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
	const { state } = await initializeSharedState(root);
	try {
		for (let index = 0; index < 12; index++) {
			await state.set({ id: `${worker}-${index}`, schema: Type.Number() }, index);
		}
	} finally {
		state.close();
	}
} else {
	throw new Error(`Unknown lock worker mode: ${mode}`);
}
