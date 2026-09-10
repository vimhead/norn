---
name: norn
description: Use when a task needs resumable execution, separate agent contexts, or reusable multi-step automation, or when creating, running, composing, or repairing Norn workflows.
---

# Norn

## Choose and use a capability

| Rule | GOOD | BAD |
|---|---|---|
| IF saved progress, a separate worker context, or reuse serves the current task, THEN use a matching Norn workflow or create/extend one within the task's scope. ELSE use ordinary tools. | Write a one-off collection workflow so another agent can continue its analysis tomorrow. | Report “no workflow exists,” or build a workflow to trim three literal strings. |
| IF the next action uses an unfamiliar interface, THEN inspect its installed command metadata or the relevant API/example. ELSE act on the known contract. | Inspect the selected workflow's inputs; check registration when a new plugin is absent. | Read every plugin before acting, assume source edits are automatically registered, or copy a CLI manual into a skill. |
| IF creating a capability, THEN implement and run the smallest bounded result in the project's existing layout; one plugin file can suffice. ELSE change the existing capability rather than duplicate it. | Write an importer, register it, and exercise one local sample before adding more stages. | Design a package hierarchy, twenty routers, or a release process before first use. |

## Choose boundaries independently

| Rule | GOOD | BAD |
|---|---|---|
| IF later work may need replay without repeating completed work, THEN persist its inputs and add a workflow transition there. ELSE keep ordinary helpers inside the step. | Save collected records before an experimental classifier. | Turn every command into a workflow, or expect resume to restore a suspended function call. |
| IF work needs fresh agent context, THEN create a separate Pi worker session; choose workspace ownership independently. ELSE reuse a session only when its accumulated context is needed. | Two fresh reviewers read one run's evidence; serialize edits to shared files. | Assume two workflow steps or two worker sessions automatically have separate filesystem workspaces or an OS sandbox. |
| IF delegating judgment, THEN give the worker an objective, bounded tools, evidence locations, and acceptance criteria. ELSE execute mechanical work directly. | Ask a worker to classify supplied records and return evidence-backed exceptions. | Copy the outer conversation into every worker, prescribe every search, or use an agent to sort an array. |
| IF a later step or agent needs a result, THEN persist its authoritative value or evidence reference and the input identity needed to verify it. ELSE leave transient detail local. | Params identify the batch, typed run state retains progress, and an artifact contains the report and dataset digest. | Depend on worker memory, duplicate a report in every handoff, or reuse a judgment after its input changed. |
| IF another caller needs the capability, THEN expose required inputs and contributed results, accept its continuation, and preserve opaque forwarded context. ELSE keep task-specific routing local. | A collector forwards the caller's task ID and contributes a report reference without reading the caller's private state. | A reusable collector imports one customer's router or treats a transition as a call that automatically returns. |

## Run, inspect, refine

| Rule | GOOD | BAD |
|---|---|---|
| IF starting or continuing execution, THEN retain the run identity and observe its next interruption, failure, or completion. ELSE inspect the existing run before creating another. | Hand another harness the run ID and evidence location; distinguish launch acknowledgment from completion. | Lose the run ID, start a duplicate, or stop the executor when only its monitor should stop. |
| IF the next behavior is still being developed and inspecting intermediate output will resolve a named uncertainty, THEN use a temporary gate at that boundary. ELSE let implemented decisions execute without a pause. | Inspect ambiguous record matches before implementing their routing rule. | Require “human approval” or “continue?” after every stage. |
| IF a gate's criteria are satisfied by current evidence and its effects are within the requested scope, THEN decide and resume yourself through its editable fields. ELSE revise, investigate, or ask only for the missing fact or permission. | Check the actual batch evidence and record the reason for accepting it. | Ask the user to rubber-stamp every gate, accept a worker's claim as proof, or rewrite protected evidence to obtain a pass. |
| IF a development gate's uncertainty is now handled by an implemented check or bounded agent decision, THEN test that behavior on a distinguishing case and retire or narrow the gate. ELSE keep the unresolved decision visible. | Verify that ambiguous records still reach an exception path after removing the development pause. | Remove a gate after an arbitrary pass count, or remove an unmet task requirement to finish the run. |
| IF repairing a failed phase, THEN inspect the failure, preserve needed evidence, reconcile effects outside snapshotted files, and resume from a compatible boundary with the repaired code. ELSE rerun earlier work only when its inputs or results are invalid. | Keep collection artifacts and retry the corrected classifier; check IDs, params and state compatibility first. | Restart collection after every edit, assume rollback undoes a remote write or project-root change, or assume it restores old plugin code. |
| IF claiming a capability works, THEN execute it and verify the requested outcome plus the rejection or recovery path affected by the change. ELSE report what is untested. | Check output records, nonzero command results, and preserved preparation after a repaired-step resume. | Treat type checking, a schema-valid worker response, or a completed run as sufficient acceptance evidence. |
| IF another attempt is justified by changed evidence or implementation and remains within the task's budget, THEN retry the affected work. ELSE stop with the specific unresolved result. | Retry after repairing a parser against the failing sample. | Repeat a valid negative judgment until an agent returns a favorable answer. |
