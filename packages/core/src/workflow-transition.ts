export function createWorkflowTransition(input: { readonly workflowId: string; readonly params: unknown }): { readonly type: "next"; readonly workflowId: string; readonly params: unknown } {
	if (typeof input.workflowId !== "string" || input.workflowId.trim().length === 0) throw new Error("Workflow transition requires a nonempty workflow ID");
	return { type: "next", workflowId: input.workflowId, params: input.params };
}
