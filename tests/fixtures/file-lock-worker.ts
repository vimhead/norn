import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createRunFileCoordinator } from "../../src/files.ts";
import { NornRunResources } from "../../src/resources.ts";
import { writeJsonAtomically } from "../../src/internal/json-file.ts";

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
	const resources = await NornRunResources.initialize(root);
	for (let index = 0; index < 12; index++) {
		await resources.state.set({ id: `${worker}-${index}`, schema: z.number() }, index);
	}
} else {
	throw new Error(`Unknown lock worker mode: ${mode}`);
}
