export const meta = {
  name: 'agent-rewind-1.0',
  description:
    'Ship Agent Rewind 0.1.x -> 1.0.0 end to end: ProviderAdapter seam (Anthropic/OpenAI/Gemini), stdio e2e verification, distribution surface, savings hardening, API freeze + release-prep. Ends at ONE draft PR; never merges, never publishes.',
  phases: [
    { title: 'Setup' },
    { title: 'M1 Provider neutrality' },
    { title: 'M2 E2E verification' },
    { title: 'M3 Distribution' },
    { title: 'M4 Savings' },
    { title: 'M5 Freeze & release-prep' },
  ],
}

// The plan is the single source of truth for WHAT each milestone builds; agents read it.
const PLAN = 'docs/superpowers/plans/2026-08-19-agent-rewind-1.0.md'
const BRANCH = 'release/1.0'

const IMPL = {
  type: 'object',
  additionalProperties: false,
  required: ['testsGreen', 'notes'],
  properties: {
    testsGreen: { type: 'boolean', description: 'did `npm run check` finish fully green (new + all existing tests)?' },
    commitSha: { type: 'string', description: 'the commit SHA for this milestone, or empty if not committed' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'what was done, and if red: the exact failing test IDs + suspected cause' },
  },
}

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'notes'],
  properties: {
    pass: { type: 'boolean', description: 'true ONLY if the milestone Acceptance in the plan is fully met and npm run check is green' },
    failingIds: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'the refutation attempt: what you tried to break and what you found' },
  },
}

const SETUP = {
  type: 'object',
  additionalProperties: false,
  required: ['branch', 'baseSha', 'baselineGreen', 'notes'],
  properties: {
    branch: { type: 'string' },
    baseSha: { type: 'string', description: 'the HEAD SHA the release branch starts from — the diff base for codex review' },
    baselineGreen: { type: 'boolean' },
    notes: { type: 'string' },
  },
}

const M5RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['soakPasses', 'codexClean', 'residuals', 'notes'],
  properties: {
    soakPasses: { type: 'integer', description: 'how many of 10 `npm run check` runs were green' },
    codexClean: { type: 'boolean', description: 'true if codex review ran and findings were addressed; false if parked/unavailable' },
    prUrl: { type: 'string' },
    residuals: { type: 'array', items: { type: 'string' }, description: 'parked human-gated steps' },
    notes: { type: 'string' },
  },
}

// One milestone = implement (read the plan section) -> bounded fix loop -> adversarial verify.
async function runMilestone(phaseTitle, sectionId, extra) {
  phase(phaseTitle)
  const brief =
    `You are implementing milestone ${sectionId} of the Agent Rewind 1.0 plan. ` +
    `FIRST read ${PLAN} and follow the "Task ${sectionId}" section EXACTLY, in order: write the failing test(s) first, ` +
    `run them to see them fail, implement the minimal code, then get \`npm run check\` FULLY green — new tests AND every ` +
    `pre-existing test. Hard rules: do NOT weaken, skip, delete, or stub any existing test to go green; do NOT edit files ` +
    `outside this milestone's declared file list; honour every line in the plan's "Global Constraints". ${extra ?? ''} ` +
    `When green, stage and commit with the milestone's commit message on the current branch (${BRANCH}). ` +
    `Capture the exit code of the test run directly (echo "EXIT=$?") — never take green from a pipe or a truncated tail. ` +
    `Return {testsGreen, commitSha, filesChanged, notes}. If you cannot get green after your best effort, return testsGreen:false with the exact failing IDs.`
  let impl = await agent(brief, { label: `impl:${sectionId}`, phase: phaseTitle, schema: IMPL, effort: 'high' })
  for (let round = 0; round < 2 && impl && !impl.testsGreen; round++) {
    impl = await agent(
      `Milestone ${sectionId} is still RED. Prior attempt notes: ${impl.notes}. Diagnose from the actual failing output ` +
        `(run \`npm run check\` and read it), fix the root cause without weakening any test, re-run until fully green, then commit. ` +
        `Return {testsGreen, commitSha, filesChanged, notes}.`,
      { label: `fix:${sectionId}#${round + 1}`, phase: phaseTitle, schema: IMPL, effort: 'high' },
    )
  }
  const verdict = await agent(
    `Adversarially verify milestone ${sectionId} against its "Acceptance" in ${PLAN}. Run \`npm run check\` YOURSELF and read the ` +
      `output — do not trust the implementer's claim. Then try to REFUTE that the acceptance is met: look specifically for a ` +
      `weakened or skipped existing test, an assertion that would pass on a do-nothing implementation, a provider that does not ` +
      `actually meter a strictly-positive figure, or the replay key being made provider-specific (a correctness violation). ` +
      `Return {pass, failingIds, notes}. Default pass=false if you are uncertain.`,
    { label: `verify:${sectionId}`, phase: phaseTitle, schema: VERDICT, effort: 'high' },
  )
  return { sectionId, testsGreen: !!impl?.testsGreen, verdictPass: !!verdict?.pass, verdict: verdict?.notes, impl: impl?.notes }
}

phase('Setup')
const setup = await agent(
  `In the git repository at the current working directory: create and switch to a fresh branch \`${BRANCH}\` off the current HEAD ` +
    `(\`git checkout -b ${BRANCH}\`; if it already exists, check it out and reset it to HEAD). If the working tree has uncommitted ` +
    `changes, commit them first with message "chore: snapshot WIP before 1.0 run" so the branch starts clean. Record baseSha = the ` +
    `current HEAD SHA after that commit (\`git rev-parse HEAD\`) — this is the diff base for the M5 codex review and PR. Then establish ` +
    `the BASELINE: run \`npm install\` then \`npm run check\`, capturing the exit code directly, and confirm it is green BEFORE any 1.0 ` +
    `change. Return {branch, baseSha, baselineGreen, notes}. If the baseline is red, return baselineGreen:false with the failing IDs and do nothing else.`,
  { label: 'setup', phase: 'Setup', schema: SETUP, effort: 'medium' },
)

if (!setup || !setup.baselineGreen) {
  log(`ABORT: baseline not green before starting (${setup ? setup.notes : 'setup agent died'}). Fix the tree, then re-run.`)
  return { aborted: true, setup }
}

const results = []
results.push(await runMilestone('M1 Provider neutrality', 'M1'))
results.push(await runMilestone('M2 E2E verification', 'M2'))
results.push(await runMilestone('M3 Distribution', 'M3'))
results.push(await runMilestone('M4 Savings', 'M4'))

// M5 is the release gate; it depends on every prior milestone landing GREEN on the branch.
// If any milestone is red or failed verify, we still open the draft PR (the review surface) but we do
// NOT stamp 1.0.0 on a broken tree — the version bump is gated on all-green.
const allGreen = results.every((r) => r.testsGreen && r.verdictPass)
const blockers = results.filter((r) => !(r.testsGreen && r.verdictPass)).map((r) => r.sectionId)
if (!allGreen) log(`NOTE: milestones not all green (${blockers.join(', ')}) — M5 will open a draft PR WITHOUT the 1.0.0 bump and flag these as blocking residuals.`)

phase('M5 Freeze & release-prep')
const m5 = await agent(
  `Execute milestone M5 of ${PLAN} on branch ${BRANCH}. ` +
    (allGreen
      ? `All prior milestones are green, so proceed with the FULL release including the 1.0.0 version bump. `
      : `WARNING: milestones ${blockers.join(', ')} did NOT reach green. Do the release-PREP but SKIP step (4) entirely — do NOT bump any version, leave them at 0.1.x — and list ${blockers.join(', ')} as BLOCKING residuals in the PR body. `) +
    `In order: (1) add the public-API snapshot tests for core and gateway and ` +
    `write docs/STABILITY.md; (2) run \`npm run check\` TEN times and count how many were green (report the count — do not stop early ` +
    `on the first pass); (3) run \`codex exec review\` UNSTEERED over \`git diff ${setup.baseSha}...HEAD\` and address its findings, ` +
    `re-reviewing until clean — \`codex\` IS installed (codex-cli); if it genuinely fails to run, PARK it as a residual and set ` +
    `codexClean:false, do NOT skip it silently; (4) bump @agent-rewind/core, /gateway, /mcp all to 1.0.0 and sync mcp's internal deps ` +
    `to ^1.0.0, write CHANGELOG.md, run \`npm install\` to sync the lockfile; (5) \`npm run build\`, then \`npm pack\` each package and ` +
    `install the three tarballs into a clean temp directory consumer and smoke it (\`npx agent-rewind --version\` + a checkpoint ` +
    `round-trip); (6) commit, push the branch to the \`rewind\` remote (\`git push -u rewind ${BRANCH}\`), then open exactly ONE DRAFT ` +
    `pull request with \`gh pr create --draft --base master --head ${BRANCH}\` titled "release: 1.0.0 — provider-neutral, verified, ` +
    `API-frozen", whose body summarises M1–M5 and lists the PARKED residuals. Do NOT merge the PR. Do NOT run \`npm publish\`. ` +
    `Return {soakPasses, codexClean, prUrl, residuals, notes}.`,
  { label: 'release-prep', phase: 'M5 Freeze & release-prep', schema: M5RESULT, effort: 'high' },
)

log(`Agent Rewind 1.0 run complete. soak=${m5?.soakPasses ?? '?'} /10, codexClean=${m5?.codexClean}, PR=${m5?.prUrl ?? 'see notes'}`)
return { setup, results, m5 }
