import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NornRunResources } from "../../src/index.ts";
import { WorkQueue, workQueueDefinition } from "../../examples/coordinating-multiple-agents/work-queue.ts";

const [root, mode, owner, leaseDuration] = process.argv.slice(2);
const leaseDurationMs = Number(leaseDuration);
const queue = await (await NornRunResources.initialize(root)).ensure({
	...workQueueDefinition, configuration: { format: 1, leaseDurationMs },
	async initialize({ directory, files, mode }) {
		const queue = new WorkQueue({ path: join(directory, "queue.json"), files, leaseDurationMs, now: Date.now, createToken: randomUUID });
		await queue.initialize(mode);
		return queue;
	},
});
if (mode === "hold") {
	const claim = await queue.claim({ owner, signal: undefined });
	if (!claim) throw new Error("No note to hold");
	process.stdout.write(JSON.stringify(claim) + "\n");
	await delay(60_000);
} else if (mode === "consume") {
	while (true) {
		const claim = await queue.claim({ owner, signal: undefined });
		if (!claim) break;
		await delay(2);
		await queue.acknowledge({ ...claim, owner, result: { summary: claim.text, quote: claim.text }, signal: undefined });
	}
} else {
	throw new Error(`Unknown queue worker mode: ${mode}`);
}
