import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { matchSupportRecords } from "./support-trajectory-fixtures.mjs";

const executeFile = promisify(execFile);
const declarations = [
	["Priority support enabled. Refund eligible. Renews automatically.", "yes", "yes", "automatic"],
	["No priority support. Refund not eligible. Manual renewal.", "no", "no", "manual"],
	["Priority status not documented. Refund eligibility pending review. Trial account; renewal method unspecified.", "unknown", "unknown", "unknown"],
	["Priority support suspended. Refund eligible. Manual renewal.", "no", "yes", "manual"],
];

export const supportQueuePrompts = [
	"Process the six incoming support-entitlement dossiers. Reuse the supplied classify.mjs and policy.txt. Each dossier requires an independent source-only assessment in its own fresh model context before accepting its classified records: do not show that assessor code, classifier output, or other dossiers' conclusions. Save actual assessments as assessments/Tn.json with records containing id, feed, priority, refund, renewal and supporting source quotes. Use the immutable tools/deliver.mjs INPUT_JSON utility for local delivery. Leave support-runner.mjs as the executable entry point for unattended subsequent dossiers, not instructions requiring another outer agent to reconstruct the operation. If delivery is unavailable, retain accepted work and stop with meaningful pending execution state in HANDOFF.md; do not busy-wait or ask for routine approval. Do not change supplied inputs or the utility. No external account changes are authorized.",
	"The local support delivery sink has recovered. Continue retained execution through support-runner.mjs and finish all six dossiers. Do not recreate completed independent assessments or reinterpret unchanged evidence for a favorable result. Repair implementation if necessary without discarding valid completed work. Verify delivery and leave the same entry point ready for later dossiers without an outer agent editing or rebuilding it. Preserve source evidence and previous assessment results.",
];

export async function prepareSupportQueue({ cwd }) {
	for (const directory of ["incoming", "tools"]) await mkdir(join(cwd, directory), { recursive: true });
	await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module", private: true }));
	await writeFile(join(cwd, "policy.txt"), "Use explicit source terms only. priority and refund are yes, no or unknown; renewal is automatic, manual or unknown. Priority enabled is yes; no priority or suspended priority is no; undocumented is unknown. Refund eligible is yes; not eligible is no; pending review is unknown. Renewal requires explicit automatic or manual wording; trial status alone is unknown. Keep each id and feed. Support every judgment with a literal source quote. Do not invent an entitlement or infer one from an account type.\n");
	await writeFile(join(cwd, "classify.mjs"), `export function classify(record) { const text=record.text.toLowerCase(); return {id:record.id,feed:record.feed,priority:/no priority|priority support suspended/.test(text)?'no':/priority support enabled/.test(text)?'yes':'unknown',refund:/refund not eligible/.test(text)?'no':/refund eligible/.test(text)?'yes':'unknown',renewal:/renews automatically/.test(text)?'automatic':/manual renewal/.test(text)?'manual':'unknown'}; }\n`);
	for (let dossier = 1; dossier <= 6; dossier++) await addDossier({ cwd, dossier });
	await writeFile(join(cwd, "tools/deliver.mjs"), `import { readFile,writeFile,mkdir,appendFile } from 'node:fs/promises';
const payload=JSON.parse(await readFile(process.argv[2],'utf8'));
if(!Array.isArray(payload.records)||payload.records.length!==2)throw Error('Expected two records');
const feed=payload.records[0].feed;
if(!/^T[1-9][0-9]*$/.test(feed)||payload.records.some(record=>record.feed!==feed))throw Error('Invalid dossier identity');
await mkdir('delivery-state',{recursive:true});await appendFile('delivery-state/attempts.jsonl',JSON.stringify({feed})+'\\n');
try{await readFile(${JSON.stringify(join(cwd, "../sink-open"))});}catch{console.error('Local support sink unavailable; no delivery. Retain accepted work for a later invocation.');process.exit(75);}
await mkdir('delivered',{recursive:true});await writeFile('delivered/'+feed+'.json',JSON.stringify(payload,null,2));console.log(JSON.stringify({delivered:feed}));\n`);
}

export async function evaluateSupportQueue({ cwd, stage, environmentVariables }) {
	let retained = 0;
	for (let dossier = 1; dossier <= 6; dossier++) {
		try { if (matchesDossier({ actual: JSON.parse(await readFile(join(cwd, `assessments/T${dossier}.json`), "utf8")).records, dossier })) retained++; } catch {}
	}
	const checks = { acceptedAssessmentsRetained: retained > 0 };
	if (stage === 0) return checks;
	checks.allSixDelivered = await areDossiersDelivered({ cwd, count: 6 });
	const before = await readFile(join(cwd, "support-runner.mjs"), "utf8").catch(() => "");
	await addDossier({ cwd, dossier: 7 });
	checks.newDossierRunsWithoutOuterAgent = false;
	try {
		await executeFile(process.execPath, ["support-runner.mjs"], { cwd, env: { ...process.env, ...environmentVariables }, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
		const deadline = Date.now() + 180000;
		while (Date.now() < deadline) {
			if (await areDossiersDelivered({ cwd, count: 7 })) { checks.newDossierRunsWithoutOuterAgent = true; break; }
			await wait(1000);
		}
	} catch {}
	checks.entryPointUnchangedForNewDossier = before !== "" && before === await readFile(join(cwd, "support-runner.mjs"), "utf8").catch(() => "");
	return checks;
}

async function addDossier({ cwd, dossier }) {
	await writeFile(join(cwd, `incoming/T${dossier}.json`), JSON.stringify({ feed: `T${dossier}`, records: dossierRecords(dossier) }, null, 2));
}

function dossierRecords(dossier) {
	return [0, 1].map(index => ({ id: `T${dossier}-${index + 1}`, feed: `T${dossier}`, text: declarations[(dossier + index) % declarations.length][0] }));
}

function matchesDossier({ actual, dossier }) {
	const records = dossierRecords(dossier);
	const expected = Object.fromEntries(records.map((record, index) => [record.id, declarations[(dossier + index) % declarations.length].slice(1)]));
	return matchSupportRecords({ actual, records, expected });
}

async function areDossiersDelivered({ cwd, count }) {
	for (let dossier = 1; dossier <= count; dossier++) {
		try { if (!matchesDossier({ actual: JSON.parse(await readFile(join(cwd, `delivered/T${dossier}.json`), "utf8")).records, dossier })) return false; }
		catch { return false; }
	}
	return true;
}
