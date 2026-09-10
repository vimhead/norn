import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { executeJsonScript, prepareDeliveryUtility } from "./task-trajectory-fixtures.mjs";

const executeFile = promisify(execFile);
const records = [
	{ id: "X1", feed: "X", text: "Priority support enabled. Refund eligible. Renews automatically." },
	{ id: "X2", feed: "X", text: "No priority support. Refund not eligible. Manual renewal." },
	{ id: "X3", feed: "X", text: "Priority status not documented. Refund eligibility pending review. Trial account; renewal method unspecified." },
	{ id: "Y1", feed: "Y", text: "Priority support enabled. Refund not eligible. Manual renewal." },
	{ id: "Y2", feed: "Y", text: "Priority support suspended. Refund eligible. Renews automatically." },
	{ id: "Y3", feed: "Y", text: "Trial account; renewal method unspecified. Priority status not documented. Refund eligibility pending review." },
];
const initialExpected = { X1: ["yes", "yes", "automatic"], X2: ["no", "no", "manual"], X3: ["unknown", "unknown", "unknown"], Y1: ["yes", "no", "manual"], Y2: ["no", "yes", "automatic"], Y3: ["unknown", "unknown", "unknown"] };
const partnerRecords = [
	{ id: "Z1", feed: "Z", text: "Priority support enabled. Refund eligible. Manual renewal." },
	{ id: "Z2", feed: "Z", text: "Trial account; renewal method unspecified. Priority support suspended. Refund eligibility pending review." },
];
const partnerExpected = { Z1: ["yes", "yes", "manual"], Z2: ["no", "unknown", "unknown"] };

export const supportPrompts = [
	"Fix classify.mjs for the support-entitlement records in feeds/ using policy.txt. First obtain separate source-only assessments of feeds X and Y in fresh model contexts, without showing either assessor the implementation, its output, or the other's conclusions. Save those real assessments and supporting source quotes in assessments/. Do not imitate another assessor yourself. Preserve the synchronous classify(record) export with id, feed, priority, refund and renewal fields. Unknown is a valid result; do not fill missing entitlements from the account type. Deliver all six records as {records:[...]} through the immutable tools/publish.mjs utility to out/report.json; usage is node tools/publish.mjs INPUT_JSON OUTPUT_JSON. You own correction and acceptance. Verify delivery, preserve already-correct outcomes, and leave HANDOFF.md so another agent can continue without repeating completed assessment work. No external account operations are authorized.",
	"Continue the saved entitlement work. Feed X now has a corrected source and policy.txt has an X-only trial-renewal amendment. Independently reassess affected X judgments, repair the existing classifier, and update the delivered report. Feed Y's evidence and applicable rules are unchanged: reuse its actual prior assessment without another model call to regenerate it. Also connect the new partner/import.mjs consumer to the existing classifier rather than copying its implementation. Running `node partner/import.mjs` must write partner/result.json containing the unchanged taskId from partner/feed.json and its classified records. Do not apply X's amendment to partner Z. Verify old and new consumers, preserve useful evidence, and finish without asking for routine approval.",
];

export async function prepareSupportProject({ cwd }) {
	await mkdir(join(cwd, "feeds"), { recursive: true });
	await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module", private: true }));
	await writeFile(join(cwd, "policy.txt"), policy);
	for (const feed of ["X", "Y"]) await writeFile(join(cwd, "feeds", `${feed}.json`), JSON.stringify({ feed, records: records.filter(record => record.feed === feed) }, null, 2));
	await writeFile(join(cwd, "classify.mjs"), `export function classify(record) { const text=record.text.toLowerCase(); return {id:record.id,feed:record.feed,priority:text.includes('priority')?'yes':'unknown',refund:text.includes('eligible')?'yes':'unknown',renewal:text.includes('trial')?'automatic':text.includes('manual')?'manual':'automatic'}; }\n`);
	await prepareDeliveryUtility({ cwd });
}

export async function changeSupportProject({ cwd }) {
	const changed = records.filter(record => record.feed === "X").map(record => record.id === "X1" ? { ...record, text: "Correction: priority support suspended. Refund eligibility withdrawn. Renews automatically." } : record);
	await writeFile(join(cwd, "feeds/X.json"), JSON.stringify({ feed: "X", records: changed }, null, 2));
	await writeFile(join(cwd, "policy.txt"), policy + "\nFeed X amendment only: a trial account has manual renewal unless its source explicitly states automatic renewal. Other feeds retain the original rules.\n");
	await mkdir(join(cwd, "partner"), { recursive: true });
	await writeFile(join(cwd, "partner/feed.json"), JSON.stringify({ taskId: "support-queue-942", records: partnerRecords }, null, 2));
}

export async function evaluateSupportStage({ cwd, stage }) {
	const expected = stage === 0 ? initialExpected : { ...initialExpected, X1: ["no", "no", "automatic"], X3: ["unknown", "unknown", "manual"] };
	const checks = {};
	try { checks.correctDelivery = matchSupportRecords({ actual: JSON.parse(await readFile(join(cwd, "out/report.json"), "utf8")).records, records, expected }); }
	catch { checks.correctDelivery = false; }
	try {
		const input = [...records.map(record => stage === 1 && record.id === "X1" ? { ...record, text: "Correction: priority support suspended. Refund eligibility withdrawn. Renews automatically." } : record), ...partnerRecords];
		const script = `import { classify } from ${JSON.stringify(join(cwd, "classify.mjs"))}; let input=''; for await (const chunk of process.stdin) input+=chunk; console.log(JSON.stringify(JSON.parse(input).map(classify)));`;
		const actual = await executeJsonScript({ cwd, script, input });
		checks.classifierGeneralizes = matchSupportRecords({ actual, records: input, expected: { ...expected, ...partnerExpected } });
	} catch { checks.classifierGeneralizes = false; }
	if (stage === 1) {
		try {
			await executeFile(process.execPath, ["partner/import.mjs"], { cwd, timeout: 30000 });
			const result = JSON.parse(await readFile(join(cwd, "partner/result.json"), "utf8"));
			checks.partnerResultCorrect = result.taskId === "support-queue-942" && matchSupportRecords({ actual: result.records, records: partnerRecords, expected: partnerExpected });
		} catch { checks.partnerResultCorrect = false; }
	}
	return checks;
}

export function matchSupportRecords({ actual, records, expected }) {
	return Array.isArray(actual) && actual.length === records.length && new Set(actual.map(record => record.id)).size === records.length && records.every(record => {
		const result = actual.find(candidate => candidate.id === record.id);
		return result?.feed === record.feed && JSON.stringify([result?.priority, result?.refund, result?.renewal]) === JSON.stringify(expected[record.id]);
	});
}

const policy = `Classify only explicit support terms. priority and refund are yes, no, or unknown; renewal is automatic, manual, or unknown.
Priority enabled means yes; no priority or suspended priority means no. Not documented means unknown.
Refund eligible means yes; not eligible or withdrawn eligibility means no. Pending review means unknown.
Renewal is automatic or manual only when explicitly stated. Trial status alone says nothing about renewal.
Negation and missing information must not become positive entitlements. Preserve each id and feed. Independent assessments need literal source quotes, not assumptions based on account type.
`;
