export const meta = {
  name: "nest-slice-build",
  description: "Autonomous per-slice build loop for the Claude Code Nest VSCode extension: fit review with a council to break design forks, build, a three-lens-plus-completeness adversarial review that loops fix-and-reverify until dry, an independent test gate, then a direct-to-main commit and push with verified Jake authorship; ends by packaging the VSIX and writing TESTING.md. Sequential across slices. Hard-stops only on the safety floor or a true dead end.",
  phases: [
    { title: "Preflight" },
    { title: "Fit Review" },
    { title: "Council" },
    { title: "Build" },
    { title: "Review" },
    { title: "Fix" },
    { title: "Test" },
    { title: "Commit and Push" },
    { title: "Release and Handoff" },
    { title: "Run Summary" }
  ]
};

// ---------------- schemas ----------------
const fitReviewSchema = {
  type: "object", additionalProperties: false,
  required: ["drift", "blocking", "summary", "planPatch"],
  properties: {
    drift: { type: "boolean" },
    blocking: { type: "boolean" },
    summary: { type: "string" },
    planPatch: {
      type: "object", additionalProperties: false,
      required: ["hasPatch", "rationale", "changes"],
      properties: {
        hasPatch: { type: "boolean" },
        rationale: { type: "string" },
        changes: { type: "array", items: { type: "string" } }
      }
    }
  }
};
const councilDecisionSchema = {
  type: "object", additionalProperties: false,
  required: ["chosen", "rationale", "confidence", "irreversible", "planPatch"],
  properties: {
    chosen: { type: "string" },
    rationale: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    irreversible: { type: "boolean" },
    planPatch: {
      type: "object", additionalProperties: false,
      required: ["hasPatch", "changes"],
      properties: { hasPatch: { type: "boolean" }, changes: { type: "array", items: { type: "string" } } }
    }
  }
};
const critiqueSchema = {
  type: "object", additionalProperties: false,
  required: ["lens", "summary", "findings"],
  properties: {
    lens: { type: "string", enum: ["correctness-build-health", "integration-fit", "read-only-data-integrity", "completeness"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["title", "severity", "category", "file", "detail", "confidence"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["critical", "major", "minor", "nit"] },
          category: { type: "string", enum: ["correctness", "build", "integration", "read-only", "data-loss", "completeness", "other"] },
          file: { type: "string" },
          detail: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        }
      }
    }
  }
};
const fixResultSchema = {
  type: "object", additionalProperties: false,
  required: ["summary", "buildPasses", "testsPass", "remainingFindings"],
  properties: {
    summary: { type: "string" },
    buildPasses: { type: "boolean" },
    testsPass: { type: "boolean" },
    remainingFindings: { type: "array", items: { type: "string" } }
  }
};
const testResultSchema = {
  type: "object", additionalProperties: false,
  required: ["passed", "command", "installable", "exitCode", "output"],
  properties: {
    passed: { type: "boolean" }, command: { type: "string" }, installable: { type: "boolean" },
    exitCode: { type: "integer" }, output: { type: "string" }
  }
};
const commitResultSchema = {
  type: "object", additionalProperties: false,
  required: ["committed", "pushed", "verifiedOnRemote", "sha", "authorVerified", "committerVerified"],
  properties: {
    committed: { type: "boolean" }, pushed: { type: "boolean" }, verifiedOnRemote: { type: "boolean" },
    sha: { type: "string" }, authorVerified: { type: "boolean" }, committerVerified: { type: "boolean" }
  }
};
const preflightSchema = {
  type: "object", additionalProperties: false,
  required: ["authorOk", "committerOk", "completedOrders", "treeClean", "note"],
  properties: {
    authorOk: { type: "boolean" }, committerOk: { type: "boolean" },
    completedOrders: { type: "array", items: { type: "integer" } },
    treeClean: { type: "boolean" }, note: { type: "string" }
  }
};
const handoffSchema = {
  type: "object", additionalProperties: false,
  required: ["packaged", "vsixPath", "testingDocWritten", "pushed", "verifiedOnRemote"],
  properties: {
    packaged: { type: "boolean" }, vsixPath: { type: "string" }, testingDocWritten: { type: "boolean" },
    pushed: { type: "boolean" }, verifiedOnRemote: { type: "boolean" }
  }
};

class HaltError {
  constructor(message, context) { this.name = "HaltError"; this.message = message; this.context = context; }
}
function isHalt(e) { return e && e.name === "HaltError"; }
function lowestMissingOrder(completed, n) {
  const have = new Set(completed || []);
  for (let i = 0; i < n; i++) if (!have.has(i)) return i;
  return n;
}
function aggregateFindings(reviews) {
  const out = [];
  for (const r of reviews) {
    if (r == null) {
      out.push({ title: "Review lens agent died", severity: "critical", category: "build",
        file: "", detail: "A review lens failed to return; failing closed.", confidence: 1 });
    } else {
      for (const f of (r.findings || [])) out.push(f);
    }
  }
  return out;
}
async function persistState(slices, i, stage, payload) {
  await agent(
    "Write the build resume-state file .nest-build-state.json at the repo root with this exact JSON " +
    "and nothing else: " + JSON.stringify({ sliceId: slices[i] ? slices[i].id : null, sliceOrder: i, stage, payload }) +
    ". Ensure .nest-build-state.json is in .gitignore (add it if missing). Do not stage, commit, or push. " +
    "Do not modify any other file.",
    { label: "persist-state", phase: "Run Summary" }
  );
}
async function runCouncil(slice, fit) {
  const angles = [
    "the simplest resolution that still ships a working slice",
    "the most robust resolution against the binding design rules and data integrity",
    "the resolution most faithful to PLAN.md and ARCHITECTURE.md"
  ];
  const proposals = await parallel(angles.map((a, idx) => () =>
    agent("DESIGN COUNCIL proposer " + (idx + 1) + ". A fit review flagged this design fork for slice " +
      slice.id + ":\n" + fit.summary + "\nRead ARCHITECTURE.md and PLAN.md (read-only). Propose " + a +
      ". State the concrete decision and its trade-offs.",
      { label: "council-propose-" + (idx + 1) + ":" + slice.id, phase: "Council" })));
  return await agent(
    "DESIGN COUNCIL judge for slice " + slice.id + ". The fork: " + fit.summary + "\nThree proposals:\n" +
    JSON.stringify(proposals.filter(Boolean)) + "\nPick the best or synthesize. Return chosen, rationale, " +
    "confidence 0..1 (honest; low means a human should decide), irreversible (true if the choice cannot be " +
    "cheaply undone or risks data loss or the read-only constraint), and a planPatch to apply before build.",
    { schema: councilDecisionSchema, label: "council-judge:" + slice.id, phase: "Council" });
}

// ---------------- main ----------------
try {
  phase("Preflight");
  // The harness can deliver args as a JSON-encoded string; coerce to an object.
  const A = (args && typeof args === "string") ? JSON.parse(args) : (args || {});
  const slices = (A && Array.isArray(A.slices)) ? A.slices : [];
  if (slices.length === 0) throw new HaltError("No slices in args.slices", { stage: "preflight" });
  const orders = slices.map(s => s.order);
  for (let i = 0; i < slices.length; i++) {
    if (!orders.includes(i)) throw new HaltError("slice orders must be contiguous 0..n-1", { stage: "preflight", orders });
  }
  slices.sort((a, b) => a.order - b.order);

  const PER_SLICE_FLOOR = (A && A.perSliceFloor) ? A.perSliceFloor : 300000;
  const MAX_FIX_ROUNDS = (A && A.maxFixRounds) ? A.maxFixRounds : 3;
  const COUNCIL_MIN = (A && A.councilMinConfidence) ? A.councilMinConfidence : 0.6;

  const pf = await agent(
    "Read-only preflight at the repo root. First run 'git fetch origin' (read-only; updates remote-tracking " +
    "refs only, does not touch the working tree). 1) Report authorOk true only if effective git user.name is " +
    "exactly 'Jake Mismas' and user.email exactly 'jake@jakemismas.com' (local overrides global; report " +
    "the EFFECTIVE values), and committerOk the same way. 2) completedOrders: a slice is done only if a " +
    "commit carrying the trailer 'Nest-Slice: <id> (<order>)' is present on origin/main " +
    "(verify against origin/main with git log origin/main or git branch -r --contains, not just local log). " +
    "3) treeClean from git status --porcelain, ignoring .nest-build-state.json. Modify nothing.",
    { schema: preflightSchema, label: "preflight", phase: "Preflight" });
  if (pf == null) throw new HaltError("Preflight agent died", { stage: "preflight" });
  if (!pf.authorOk || !pf.committerOk) throw new HaltError("git identity is not Jake Mismas <jake@jakemismas.com>", { stage: "preflight", pf });

  const startIndex = lowestMissingOrder(pf.completedOrders, slices.length);
  const builtSlices = (pf.completedOrders || []).map(o => (slices[o] ? slices[o].id : String(o)));
  const decisions = [];
  log("Preflight ok. Resuming at slice order " + startIndex + " of " + slices.length + ".");

  for (let i = startIndex; i < slices.length; i++) {
    const slice = slices[i];
    log("Slice " + i + "/" + (slices.length - 1) + " (" + slice.id + ")");

    if (budget.total && budget.remaining() <= PER_SLICE_FLOOR) {
      await persistState(slices, i, "budget", {});
      throw new HaltError("Budget floor reached before slice " + slice.id, { stage: "budget", slice: slice.id });
    }
    if (!pf.treeClean && i === startIndex) {
      const reset = await agent(
        "Restore a clean working tree for a resumed build WITHOUT any force command (git reset --hard, " +
        "git checkout -f, and git branch -f are all blocked by the hook). 1) 'git fetch origin'. 2) Discard " +
        "uncommitted working changes: 'git stash -u' (or 'git checkout -- .' then 'git clean -fd', which " +
        "preserves .nest-build-state.json and gitignored paths). 3) 'git checkout main' then " +
        "'git merge --ff-only origin/main' to advance main to the latest merged commit. 4) Best-effort delete " +
        "leftover merged slice/* branches with 'git branch -d' (ignore failures). Confirm git status " +
        "--porcelain is empty except the state file. Do not push.",
        { label: "reset-tree", phase: "Build" });
      if (reset == null) throw new HaltError("Tree reset agent died on resume", { stage: "reset", slice: slice.id });
    }

    // ---- Fit review (+ council on a fork) ----
    phase("Fit Review");
    const fit = await agent(
      "FIT REVIEW for the next slice before building. Read ARCHITECTURE.md and the already-built slices [" +
      builtSlices.join(", ") + "]. Slice plan:\n" + JSON.stringify(slice) + "\nFlag drift. Set blocking true " +
      "only if a real design decision is needed to proceed. If small adjustments suffice, return a planPatch. " +
      "Read-only; do not edit files.",
      { schema: fitReviewSchema, label: "fit:" + slice.id, phase: "Fit Review" });
    if (fit == null) throw new HaltError("Fit review died for " + slice.id, { stage: "fit", slice: slice.id });

    const patches = [];
    if (fit.planPatch && fit.planPatch.hasPatch) patches.push({ source: "fit", changes: fit.planPatch.changes });
    if (fit.blocking) {
      phase("Council");
      const decision = await runCouncil(slice, fit);
      if (decision == null || decision.irreversible || decision.confidence < COUNCIL_MIN) {
        await persistState(slices, i, "council", { fit, decision });
        throw new HaltError("Design fork needs a human (council low-confidence or irreversible) for " + slice.id,
          { stage: "council", slice: slice.id, fit, decision });
      }
      decisions.push({ slice: slice.id, fork: fit.summary, chosen: decision.chosen, rationale: decision.rationale });
      if (decision.planPatch && decision.planPatch.hasPatch) patches.push({ source: "council", changes: decision.planPatch.changes });
      await agent(
        "Append a dated entry to DECISIONS.md at the repo root (create it if missing) recording this " +
        "autonomous design decision. Entry: slice " + slice.id + "; fork: " + fit.summary + "; chosen: " +
        decision.chosen + "; rationale: " + decision.rationale + ". Do not stage, commit, or push. No em " +
        "dashes, en dashes, or emojis.",
        { label: "log-decision:" + slice.id, phase: "Council" });
      log("Council decided for " + slice.id + ": " + decision.chosen);
    }
    const mergedPlan = { slice, patches };

    // ---- Build ----
    phase("Build");
    const build = await agent(
      "BUILD this slice for the Claude Code Nest VSCode extension. Implement to the plan, honoring the binding " +
      "design rules in ARCHITECTURE.md (read-only on ~/.claude/projects, composite-id tree model, visited-set " +
      "cycle detection, surgical settings write, per-project sync keys, refresh coalescing). Plan and any " +
      "accepted patches:\n" + JSON.stringify(mergedPlan) + "\nNever create scratch, probe, throwaway, or " +
      "lint-test files under src/ or out/; they break the tsc and eslint gates and can ship in the VSIX. If you " +
      "must create a temporary file to verify a rule, put it under .claude-working/ (gitignored) and remove it " +
      "when done. Run the compile to confirm it builds. Do NOT git " +
      "add, commit, or push. No em dashes, en dashes, or emojis in code or docs.",
      { label: "build:" + slice.id, phase: "Build" });
    if (build == null) throw new HaltError("Build agent died for " + slice.id, { stage: "build", slice: slice.id });

    // ---- Loop-until-dry: review (3 lenses + completeness) then fix, up to MAX_FIX_ROUNDS ----
    let round = 0;
    while (true) {
      round += 1;
      phase("Review");
      const reviews = await parallel([
        () => agent("Adversarial REVIEW, lens correctness-build-health. REFUTE the slice's correctness and " +
          "build health: compile and lint errors, logic bugs, missing error handling, broken edge cases. Read " +
          "the diff and files. Slice " + slice.id + ". critical = build-breaking or incorrect behavior. Round " +
          round + ".", { schema: critiqueSchema, label: "rev-correctness:" + slice.id, phase: "Review" }),
        () => agent("Adversarial REVIEW, lens integration-fit. REFUTE that this slice integrates with the " +
          "built slices [" + builtSlices.join(", ") + "] and ARCHITECTURE.md: contract drift, tree-id " +
          "collisions, store-schema mismatch, command or menu id clashes. Read the files. Slice " + slice.id +
          ". Round " + round + ".", { schema: critiqueSchema, label: "rev-integration:" + slice.id, phase: "Review" }),
        () => agent("Adversarial REVIEW, lens read-only-data-integrity (the SACRED constraint). REFUTE that " +
          "the slice is safe: ANY path that could write, rename, move, or delete under ~/.claude/projects/, " +
          "bypass the read-only chokepoint, or lose or corrupt the metadata store. Mark such findings category " +
          "read-only or data-loss and severity critical. Read the files. Slice " + slice.id + ". Round " + round + ".",
          { schema: critiqueSchema, label: "rev-readonly:" + slice.id, phase: "Review" }),
        () => agent("COMPLETENESS critic, lens completeness. What did the slice MISS versus its plan and DoD: " +
          "an unimplemented acceptance item, an untested pure-logic unit, a missing edge case, a doc not " +
          "updated. List gaps as findings. Slice " + slice.id + ". Round " + round + ".",
          { schema: critiqueSchema, label: "rev-completeness:" + slice.id, phase: "Review" })
      ]);
      const findings = aggregateFindings(reviews);
      const actionable = findings.filter(f => f.severity === "critical" || f.severity === "major");
      if (actionable.length === 0) { log("Slice " + slice.id + " review came back dry after round " + round + "."); break; }
      if (round > MAX_FIX_ROUNDS) {
        const safety = actionable.filter(f => f.category === "read-only" || f.category === "data-loss");
        await persistState(slices, i, "review", { actionable });
        throw new HaltError("Slice " + slice.id + " still has " + actionable.length + " actionable finding(s) after " +
          MAX_FIX_ROUNDS + " fix rounds" + (safety.length ? " including a SAFETY-FLOOR issue" : "") + "; not committing.",
          { stage: "review", slice: slice.id, actionable, safety });
      }
      if (budget.total && budget.remaining() <= PER_SLICE_FLOOR) {
        await persistState(slices, i, "budget", { actionable });
        throw new HaltError("Budget floor reached mid-slice " + slice.id, { stage: "budget", slice: slice.id });
      }
      phase("Fix");
      const fix = await agent(
        "FIX PASS (round " + round + " of up to " + MAX_FIX_ROUNDS + "). Resolve ALL of these actionable " +
        "findings, then re-check by rebuilding AND running the slice tests (" + (slice.testCommand || "npm test") +
        "). Report buildPasses, testsPass, and any remainingFindings. Findings:\n" + JSON.stringify(actionable) +
        "\nKeep any scratch or probe files under .claude-working/ (gitignored), never under src/ or out/, and " +
        "remove them before reporting. Do NOT commit or push.",
        { schema: fixResultSchema, label: "fix:" + slice.id + ":r" + round, phase: "Fix" });
      if (fix == null) throw new HaltError("Fix agent died for " + slice.id, { stage: "fix", slice: slice.id });
      // loop re-reviews; the next round is the independent re-verification.
    }

    // ---- Independent test gate ----
    phase("Test");
    const test = await agent(
      "TEST GATE. Run exactly '" + (slice.testCommand || "npm test") + "' and separately the install/package " +
      "check '" + (slice.installCheck || "npx vsce package --no-dependencies -o /tmp/nest.vsix") + "'. Report " +
      "passed (test exit 0), installable (install check exit 0), exitCode, and the output tail. Do not fix or commit.",
      { schema: testResultSchema, label: "test:" + slice.id, phase: "Test" });
    if (test == null || test.passed !== true || test.installable !== true || test.exitCode !== 0) {
      await persistState(slices, i, "test", { test });
      throw new HaltError("Tests or install check failed for " + slice.id, { stage: "test", slice: slice.id, test });
    }

    // ---- Commit and push (direct to main) ----
    phase("Commit and Push");
    const commit = await agent(
      "COMMIT this slice and land it on main via a pull request (direct pushes to main are blocked by a " +
      "safety hook; the PR-then-merge flow is the sanctioned path). 1) Update ARCHITECTURE.md (fold in " +
      "accepted patches: " + JSON.stringify(mergedPlan.patches) + "), add a CHANGELOG entry for slice " +
      slice.id + ", and stage DECISIONS.md if it changed. 2) git status --porcelain: confirm only expected " +
      "slice files plus ARCHITECTURE.md, CHANGELOG.md, and DECISIONS.md changed; .nest-build-state.json must " +
      "be gitignored and excluded. 3) Re-verify effective git user.name is 'Jake Mismas' and user.email " +
      "'jake@jakemismas.com' so author and committer are BOTH Jake. Do NOT use the --author flag or " +
      "GIT_AUTHOR_*/GIT_COMMITTER_* env overrides; the hook blocks them and the local config already makes " +
      "both Jake. Create a branch 'slice/" + slice.id + "' with 'git checkout -b slice/" + slice.id + "' (this " +
      "carries the uncommitted build changes onto the branch, leaving main clean), and commit there. Subject " +
      "imperative, under 70 chars, no emoji, no em or en dashes, NO AI co-author trailer, NO generated-by " +
      "marker. Append trailer 'Nest-Slice: " + slice.id + " (" + i + ")'. 4) Push the branch with " +
      "'git push -u origin slice/" + slice.id + "', open a PR into main with 'gh pr create --base main --head " +
      "slice/" + slice.id + " --title <subject> --body <short body>', then merge it with a MERGE COMMIT so the " +
      "slice commit lands on main unchanged: 'gh pr merge --merge --delete-branch' (pass the PR number or url). " +
      "Do NOT push to main directly. 5) Sync local main WITHOUT any force command (git reset --hard is blocked " +
      "by the hook): 'git fetch origin', 'git checkout main', then 'git merge --ff-only origin/main' (local " +
      "main is strictly behind origin/main after the merge, so this fast-forwards cleanly). 6) VERIFY: the " +
      "slice commit carrying the Nest-Slice trailer is now on " +
      "origin/main (git log origin/main), and on THAT slice commit the author is 'Jake Mismas " +
      "<jake@jakemismas.com>' and the committer is the same. Report committed, pushed, verifiedOnRemote (true " +
      "only if the trailer commit is on origin/main), sha (the slice commit sha), authorVerified, and " +
      "committerVerified (both checked on the slice commit, not the GitHub merge commit).",
      { schema: commitResultSchema, label: "commit:" + slice.id, phase: "Commit and Push" });
    if (commit == null || !commit.committed || !commit.pushed || !commit.verifiedOnRemote
        || !commit.authorVerified || !commit.committerVerified) {
      await persistState(slices, i, "commit", { commit });
      throw new HaltError("Commit/push/verify failed for " + slice.id, { stage: "commit", slice: slice.id, commit });
    }
    builtSlices.push(slice.id);
    log("Slice " + slice.id + " committed and pushed: " + commit.sha);
  }

  // ---- Release and handoff ----
  phase("Release and Handoff");
  const handoff = await agent(
    "RELEASE AND HANDOFF. 1) Ensure README and CHANGELOG reflect the finished extension. 2) Package the VSIX " +
    "(npx vsce package) and report its path. 3) Write TESTING.md at the repo root: how to install the VSIX " +
    "(code --install-extension <path>, or the Extensions: Install from VSIX command), and the consolidated " +
    "manual smoke checklist drawn from every slice's smoke steps in PLAN.md, since UI smoke needs a human. " +
    "4) Land it on main via a PR (direct pushes to main are blocked): commit on a branch 'slice/handoff' " +
    "with author and committer both Jake (local config; no --author flag, no AI trailer, no generated-by " +
    "marker, no em or en dashes, no emoji), push the branch, open a PR into main with gh, merge it with " +
    "'gh pr merge --merge --delete-branch', then 'git fetch origin', 'git checkout main', and " +
    "'git merge --ff-only origin/main' (do NOT use git reset --hard; it is blocked) and verify the handoff " +
    "commit is on origin/main. Do NOT push to main directly. Report packaged, " +
    "vsixPath, testingDocWritten, pushed, verifiedOnRemote.",
    { schema: handoffSchema, label: "handoff", phase: "Release and Handoff" });
  if (handoff == null || !handoff.packaged || !handoff.testingDocWritten || !handoff.pushed || !handoff.verifiedOnRemote) {
    await persistState(slices, slices.length - 1, "handoff", { handoff });
    throw new HaltError("Release and handoff failed", { stage: "handoff", handoff });
  }

  phase("Run Summary");
  log("Done. " + slices.length + " slices on main. Decisions: " + decisions.length +
    ". VSIX: " + handoff.vsixPath + ". Manual smoke checklist is in TESTING.md.");
  return { ok: true, built: builtSlices, decisions, vsixPath: handoff.vsixPath };
} catch (e) {
  const ctx = (e && e.context) ? e.context : { stage: "unknown" };
  log("HALT: " + (e && e.message ? e.message : String(e)) + " | stage=" + (ctx.stage || "unknown") +
    (ctx.slice ? (" slice=" + ctx.slice) : "") + ". Working tree left for inspection; re-invoke to resume.");
  throw e;
}
