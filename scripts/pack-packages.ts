import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packReleasePackages } from "./release-packages.ts";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const outputDirectory = join(workspaceRoot, "dist/npm");
const packages = await packReleasePackages({ workspaceRoot, outputDirectory });
await writeFile(join(outputDirectory, "release.json"), `${JSON.stringify({ packages }, null, 2)}\n`);
console.log(`Packed ${packages.map(pkg => `${pkg.name}@${pkg.version}`).join(", ")}`);
