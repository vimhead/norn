import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { prepareRelease } from "../scripts/prepare-release.ts";
import {
	assertTipVersion,
	PUBLISHED_WORKSPACES,
	verifyExistingPublication,
} from "../scripts/release-packages.ts";

test("release versions are immutable tip prereleases, not stable or moving tags", () => {
	for (const version of ["0.1.0-tip.0", "0.1.0-tip.123456789.2"])
		assert.doesNotThrow(() => assertTipVersion(version));
	for (const version of [
		"latest",
		"tip",
		"0.1.0",
		"0.1.0-beta.1",
		"0.1.0-tip.01",
		"0.1.0-tip.1/evil",
	])
		assert.throws(() => assertTipVersion(version));
});

test("publication retries require the exact artifact and cannot move an already-published version back to tip", () => {
	const expected = {
		name: "@vimhead.dev/norn",
		version: "0.1.0-tip.2.1",
		filename: "library.tgz",
		integrity: "sha512-exact-artifact",
	};
	assert.equal(
		verifyExistingPublication({ expected, integrity: null, tipVersion: null }),
		false,
	);
	assert.equal(
		verifyExistingPublication({
			expected,
			integrity: expected.integrity,
			tipVersion: expected.version,
		}),
		true,
	);
	assert.throws(
		() =>
			verifyExistingPublication({
				expected,
				integrity: "sha512-other",
				tipVersion: expected.version,
			}),
		/artifact differs/,
	);
	assert.throws(
		() =>
			verifyExistingPublication({
				expected,
				integrity: expected.integrity,
				tipVersion: "0.1.0-tip.3.1",
			}),
		/prepare a new release version/,
	);
});

test("release preparation aligns public manifests and stamps npm and binary identity without versioning private core", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "norn-release-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const manifests = [
		"package.json",
		...PUBLISHED_WORKSPACES.map(
			(workspace) => `packages/${workspace}/package.json`,
		),
		"packages/core/package.json",
	];
	for (const path of manifests) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(
			join(root, path),
			JSON.stringify({
				name: path,
				version: "0.1.0-tip.0",
				customField: "preserved",
			}),
		);
	}
	await mkdir(join(root, "packages/cli/src"));
	const input = {
		workspaceRoot: root,
		version: "0.1.0-tip.10.1",
		commit: "a".repeat(40),
		binaryAsset: null,
	};
	await prepareRelease(input);
	for (const path of manifests.slice(0, -1)) {
		const manifest = JSON.parse(await readFile(join(root, path), "utf8"));
		assert.equal(manifest.version, input.version);
		assert.equal(manifest.customField, "preserved");
	}
	assert.equal(
		JSON.parse(await readFile(join(root, "packages/core/package.json"), "utf8"))
			.version,
		"0.1.0-tip.0",
	);
	const metadataPath = join(root, "packages/cli/src/generated-build-info.ts");
	const npmMetadata = await readFile(metadataPath, "utf8");
	assert.match(npmMetadata, /"kind": "npm-registry"/);
	assert.match(npmMetadata, /@vimhead.dev\/norn-cli@tip/);
	assert.ok(npmMetadata.includes(input.commit));
	await prepareRelease({ ...input, binaryAsset: "norn-linux-x64" });
	const binaryMetadata = await readFile(metadataPath, "utf8");
	assert.match(binaryMetadata, /"kind": "github-release-binary"/);
	assert.match(binaryMetadata, /"checksumAssetName": "norn-linux-x64.sha256"/);
	await assert.rejects(
		prepareRelease({ ...input, version: "0.1.0" }),
		/tip prerelease/,
	);
	assert.equal(await readFile(metadataPath, "utf8"), binaryMetadata);
});
