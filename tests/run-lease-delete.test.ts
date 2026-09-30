import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { NornRunLease } from "../packages/cli/src/internal/run-lease.ts";

for (const failure of ["none", "rename", "cleanup"]) {
	test(`whole-run deletion retires the leased directory before cleanup (${failure})`, async () => {
		const project = await fs.mkdtemp(join(tmpdir(), "norn-lease-delete-"));
		const runRoot = join(project, ".norn/runs/run");
		await fs.mkdir(runRoot, { recursive: true });
		await fs.writeFile(
			join(runRoot, "evidence.txt"),
			"retained until retirement",
		);
		const lease = await NornRunLease.acquire(runRoot);
		const originalRm = fs.rm;
		const originalRename = fs.rename;
		let retiredRoot: string | undefined;
		const renameSpy = vi
			.spyOn(fs, "rename")
			.mockImplementation(async (source, destination) => {
				if (source === runRoot) {
					if (failure === "rename")
						throw new Error("Injected retirement failure");
					retiredRoot = String(destination);
				}
				return originalRename(source, destination);
			});
		const rmSpy = vi
			.spyOn(fs, "rm")
			.mockImplementation(async (path, options) => {
				if (path === retiredRoot) {
					await assert.rejects(fs.access(runRoot), { code: "ENOENT" });
					assert.equal(
						await fs.readFile(join(retiredRoot!, "evidence.txt"), "utf8"),
						"retained until retirement",
					);
					if (failure === "cleanup")
						throw new Error("Injected cleanup failure");
				}
				return originalRm(path, options);
			});
		syncBuiltinESMExports();
		try {
			if (failure === "none") {
				await lease.deleteRunDirectory();
				assert.ok(retiredRoot);
				await assert.rejects(fs.access(retiredRoot), { code: "ENOENT" });
			} else if (failure === "rename") {
				await assert.rejects(
					lease.deleteRunDirectory(),
					/Injected retirement failure/,
				);
				await lease.assertOwned();
				assert.equal(
					await fs.readFile(join(runRoot, "evidence.txt"), "utf8"),
					"retained until retirement",
				);
			} else {
				await assert.rejects(
					lease.deleteRunDirectory(),
					/removed from the run list.*cleanup failed/,
				);
				assert.ok(retiredRoot?.startsWith(join(project, ".norn/.pruned-run-")));
				await assert.rejects(fs.access(runRoot), { code: "ENOENT" });
			}
			await lease.release();
			if (failure !== "rename") {
				await assert.rejects(fs.access(runRoot), { code: "ENOENT" });
				await assert.rejects(lease.assertOwned(), /released/);
			}
		} finally {
			renameSpy.mockRestore();
			rmSpy.mockRestore();
			syncBuiltinESMExports();
			await lease.release();
			await originalRm(project, { recursive: true, force: true });
		}
	});
}
