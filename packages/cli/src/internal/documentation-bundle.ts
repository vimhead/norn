import { createHash } from "node:crypto";

export type NornDocumentationFile = {
	readonly path: string;
	readonly content: string;
};

export type NornDocumentationBundle = {
	readonly version: string;
	readonly files: readonly NornDocumentationFile[];
};

export const DOCUMENTATION_PATHS = {
	readme: "README.md",
	index: "docs/README.md",
	docs: "docs",
	examples: "examples",
} as const;

export function validateDocumentationBundle(
	bundle: NornDocumentationBundle,
): void {
	if (typeof bundle.version !== "string" || bundle.version.length === 0)
		throw new Error("Documentation bundle version must not be empty");
	const paths = new Set<string>();
	for (const file of bundle.files) {
		if (typeof file.content !== "string")
			throw new Error(`Documentation asset must contain text: ${file.path}`);
		if (
			typeof file.path !== "string" ||
			!/^[a-zA-Z0-9._/-]+$/.test(file.path) ||
			file.path
				.split("/")
				.some(
					(part) =>
						part === "" ||
						part === "." ||
						part === ".." ||
						part.endsWith(".") ||
						/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
				)
		) {
			throw new Error(`Invalid documentation asset path: ${file.path}`);
		}
		const portablePath = file.path.toLowerCase();
		if (paths.has(portablePath))
			throw new Error(`Duplicate documentation asset path: ${file.path}`);
		paths.add(portablePath);
	}
	for (const path of paths) {
		const parts = path.split("/");
		while (parts.pop() && parts.length > 0) {
			if (paths.has(parts.join("/")))
				throw new Error(`Documentation file/directory collision: ${path}`);
		}
	}
	for (const path of [DOCUMENTATION_PATHS.readme, DOCUMENTATION_PATHS.index]) {
		if (!bundle.files.some((file) => file.path === path))
			throw new Error(`Missing documentation asset: ${path}`);
	}
	if (!bundle.files.some((file) => file.path.startsWith("examples/")))
		throw new Error("Missing documentation examples");
}

export function hashDocumentationBundle(
	bundle: NornDocumentationBundle,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				version: bundle.version,
				files: bundle.files
					.map((file) => ({ path: file.path, content: file.content }))
					.sort((left, right) =>
						left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
					),
			}),
		)
		.digest("hex");
}
