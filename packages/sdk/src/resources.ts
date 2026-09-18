import type { NornFileCoordinator } from "./files.ts";
import type { NornJsonValue } from "./schema.ts";

export type NornResourceContext = {
	readonly mode: "create" | "open";
	readonly directory: string;
	readonly files: NornFileCoordinator;
};

export type NornResourceDefinition<T> = {
	readonly name: string;
	readonly kind: string;
	readonly configuration: NornJsonValue;
	initialize(context: NornResourceContext): Promise<T>;
};

export type NornResources = {
	readonly files: NornFileCoordinator;
	ensure<T>(definition: NornResourceDefinition<T>): Promise<T>;
};
