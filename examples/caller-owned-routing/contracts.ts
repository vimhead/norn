import { Type } from "typebox";

export const headingSchema = Type.String({ minLength: 1, pattern: "^[^\\r\\n]+$" });
export const headingsSchema = Type.Array(headingSchema, { uniqueItems: true });
export const outlineContributionSchema = Type.Object({ outline: Type.String() });
export const assessmentContributionSchema = Type.Object({
	...outlineContributionSchema.properties,
	requiredHeadings: headingsSchema,
	missingHeadings: headingsSchema,
});
