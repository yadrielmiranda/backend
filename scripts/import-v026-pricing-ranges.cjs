'use strict';

// Import the exact tested V026 workbook into the original pricing catalog.
// This is creation-only: it never removes or updates existing pricing ranges.
// Default is a read-only plan. Uses the generic importer's backup, exact target,
// fresh-plan, atomic write, and rollback safeguards. Never starts Nest workers.
const { run } = require('./import-pricing-ranges.cjs');
const { buildPlan, hash, ruleKey } = require('./pricing-range-import-core.cjs');
const { verifyNoaCoverage, resolvePlanRanges } = require('./v026-noa-coverage.cjs');

const SOURCE_SHA = '09817554177798ada127ddd11b62bb90d3cc58f9216c4df5b3760be96a7ce739';
const INPUT_SHA = '88e82637fd17a332493e3bc44c49db96b87e70835cfc2b465aed86466a9796f0';
const COVERAGE_MESSAGE = 'Active ranges do not uniquely cover all positive dimensions; review coverage before replacing the general rules.';

function validateSource(input) {
  if (input?.sourceSha256 !== SOURCE_SHA || input?.schemaVersion !== 1 || input?.rows?.length !== 518 || hash(input) !== INPUT_SHA) {
    throw new Error('Prepared data differs from the exact tested V026 workbook. Use the unchanged pricing-ranges-v026.json file.');
  }
}

function applyProfile(plan, resolvedRanges, coverageProof) {
  // The NOA proof can replace only this one generic whole-positive-plane
  // coverage finding. All overlap, precision, crystal, and other findings stay.
  const groups = plan.groups.filter(group => group.brand === 'Eco Windows Systems' && group.product === 'Fixed Window' &&
    group.system === 'Serie 70' && group.configuration === 'Picture Window (O)');
  const boundedGroup = groups.length === 1 ? `${groups[0].idSystem}:${groups[0].idConfig}` : null;
  const findings = plan.errors.filter(error => error.group === boundedGroup && error.message === COVERAGE_MESSAGE);
  if (!boundedGroup || coverageProof?.group !== boundedGroup || findings.length !== 1) {
    plan.errors.push({ message: 'V026 bounded coverage proof does not resolve exactly the reviewed Serie 70 finding.' });
  } else {
    plan.errors = plan.errors.filter(error => !findings.includes(error));
    plan.noaCoverageProof = coverageProof;
    plan.resolvedCoverageFindings = findings;
  }
  const s = plan.summary;
  const keys = new Set(resolvedRanges.flatMap(range => range.rules.map(rule => ruleKey({ ...range, ...rule }))));
  if (s.inputRows !== 518 || s.groups !== 16 || s.ranges !== 296 || s.crystalRules !== 518 ||
      resolvedRanges.length !== 296 || resolvedRanges.some(range => !range.isActive) || keys.size !== 29) {
    plan.errors.push({ message: 'V026 must resolve to exactly 16 groups, 296 active ranges, 518 crystal rules, and 29 system/configuration/crystal combinations.' });
  }
  const deletedKeys = new Set(plan.directRulesToRemove.map(ruleKey));
  const pristine = s.createRanges === 296 && s.unchangedRanges === 0 && plan.directRulesToRemove.length === 29 &&
    deletedKeys.size === 29 && [...deletedKeys].every(key => keys.has(key));
  const alreadyApplied = s.createRanges === 0 && s.unchangedRanges === 296 && plan.directRulesToRemove.length === 0;
  if (!pristine && !alreadyApplied) {
    plan.errors.push({ message: 'V026 requires the original 29 general rules with no imported V026 ranges, or a complete identical import. Partial or changed catalogs need a new review.' });
  }
  if (plan.warnings.length) {
    plan.errors.push({ message: 'V026 has catalog warnings that need review before import.' });
  }
  plan.summary.errors = plan.errors.length;
  return plan;
}

async function boundV026Plan(input, catalog, target, tx) {
  validateSource(input);
  const plan = buildPlan(input, catalog);
  try {
    const resolvedRanges = resolvePlanRanges(plan, catalog);
    const proof = await verifyNoaCoverage(tx, catalog, resolvedRanges);
    applyProfile(plan, resolvedRanges, proof);
  } catch (error) {
    // Keep the unresolved generic coverage error and every other core finding.
    // The default dry-run can then produce a useful blocking report.
    plan.errors.push({ message: error.code ? `V026 coverage verification failed (${error.code}).` : error.message });
    plan.summary.errors = plan.errors.length;
  }
  delete plan.planHash;
  plan.profile = 'tested-v026-creation-only';
  plan.database = target;
  plan.inputHash = hash(input);
  plan.planHash = hash(plan);
  return plan;
}

module.exports = { SOURCE_SHA, INPUT_SHA, COVERAGE_MESSAGE, validateSource, applyProfile, boundV026Plan };
if (require.main === module) run(process.argv.slice(2), { planner: boundV026Plan }).catch(error => {
  if (error.importCommitted) console.error('The import committed, but the final report could not be saved. Run a read-only dry-run to verify the current state.');
  else console.error(error.code ? `Import did not finish verification (${error.code}). Run a read-only dry-run to determine the current state.` : error.message);
  process.exitCode = 1;
});
