import type { z } from "zod";
import type { NornFileCoordinator } from "./files.ts";

export type NornResourceContext = {
	readonly mode: "create" | "open";
	readonly directory: string;
	readonly files: NornFileCoordinator;
};

export type NornResourceDefinition<T> = {
	readonly name: string;
	readonly kind: string;
	readonly configuration: z.infer<ReturnType<typeof z.json>>;
	initialize(context: NornResourceContext): Promise<T>;
};

export type NornResources = {
	readonly files: NornFileCoordinator;
	ensure<T>(definition: NornResourceDefinition<T>): Promise<T>;
};
