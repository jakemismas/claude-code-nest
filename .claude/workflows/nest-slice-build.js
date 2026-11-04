/*
 * slice-build-template.js -- generalized, parameterized per-slice build engine
 * for the Claude Code Workflow harness (export const meta, agent(), parallel(),
 * phase(), log(), and the budget globals).
 *
 * PROVENANCE (the only place project-specific names appear in this file):
 * generalized from the Claude Code Nest engine at
 * github.com/jakemismas/claude-code-nest, .claude/workflows/nest-slice-build.js.
 * That source hardcoded: the identity Jake Mismas <jake@jakemismas.com>, the
 * "Nest-Slice:" / "Nest-Security:" trailers, a "sprint-2" security trailer-id
 * fallback, the .nest-build-state.json state file, the read-only
 * ~/.claude/projects/ sacred constraint, Nest review lenses (webview-xss,
 * read-only boundary, sync-data-loss), vsce/VSIX packaging, a minisearch
 * supply-chain focus, media/design/ visual-reference paths, and UI-SPEC.md.
 * All of those are parameterized (or dropped and noted in comments) below.
 *
 * INSTALL
 *   Copy this file to <your repo>/.claude/workflows/<project>-slice-build.js
 *   and invoke it BY scriptPath, not by workflow name, to dodge stale
 *   workflow-name caches (porting caveat f below).
 *
 * ARGS CONTRACT
 *   identity            REQUIRED {name, email}. The only allowed git author
 *                       and committer. The engine throws at startup if absent.
 *   trailerPrefix       REQUIRED non-empty string, e.g. "Myproj". Trailer
 *                       formats are exactly "<prefix>-Slice: <id> (<order>)"
 *                       and "<prefix>-Security: <trailerId> (audit)".
 *   slices              REQUIRED array, orders contiguous 0..n-1. Per slice:
 *                       {id, order, issue?, testCommand?, installCheck?,
 *                        visualCheck?, ...free-form plan fields}.
 *   planDoc             default "PLAN.md". WARNING: later sprints MUST pass
 *                       this explicitly or the councils and handoff read the
 *                       wrong plan document.
 *   stateFile           default ".slice-build-state.json". Gitignored,
 *                       write-only breadcrumb; never staged.
 *   sacredConstraints   array of strings (may be empty). Injected into the
 *                       build prompt, the sacred-constraint review lens, the
 *                       council judge's irreversibility test, and every
 *                       security-council lens.
 *   defaultTestCommand  default "npm test"; per-slice testCommand overrides.
 *   defaultInstallCheck no default. Every slice must have installCheck or
 *                       this must be set (the upstream engine defaulted to a
 *                       project-specific package command; that default was
 *                       removed, see the Test gate comment).
 *   packageCommand      optional. Run at handoff to produce the distributable
 *                       artifact (the upstream engine hardcoded its extension
 *                       packager here). If unset, handoff skips packaging.
 *   runHandoff          default true. When false, the Release and Handoff
 *                       phase is skipped entirely. Non-final parts of a
 *                       multi-part sprint should pass false so mid-sprint
 *                       parts do not package half-built artifacts or refresh
 *                       README; only the final part hands off.
 *   visualReference     optional free-text naming the binding design docs and
 *                       reference-screenshot location for UI slices (the
 *                       upstream engine hardcoded its design-folder paths).
 *   perSliceFloor       default 300000 OUTPUT TOKENS (see PER_SLICE_FLOOR).
 *   maxFixRounds        default 3.
 *   councilMinConfidence default 0.6.
 *   securityCouncil     optional {trailerId (REQUIRED when this object is
 *                       set; no fallback), beforeSliceId (REQUIRED when this
 *                       object is set; preflight halts when it matches no
 *                       slice), baselineRef
 *                       (REQUIRED when this object is set; validated at
 *                       startup, no silent fallback -- the council diffs
 *                       origin/main against this ref), issue?,
 *                       changeSetLabel?, maxRounds?, extraLenses?}.
 *                       extraLenses is an array of {key, prompt} appended to
 *                       the 7 generic security lenses.
 *   localLanding        default false. When false, every behavior and prompt
 *                       is the template's (PR-per-slice landing on origin/main).
 *                       When true, nothing is ever pushed and GitHub is never
 *                       written to: each slice lands on a LOCAL integration
 *                       branch (see integrationBranch) with a no-ff merge, and
 *                       the driver pushes and opens PRs by hand later.
 *   integrationBranch   default "main". Must match /^[A-Za-z0-9._\/-]+$/ and
 *                       must not start with "-" (validated whenever given). Used
 *                       only when localLanding is true, where it must not be
 *                       "main" and must exist locally (preflight halts
 *                       otherwise). When localLanding is false, main is used.
 *
 * EXAMPLE ARGS
 * {
 *   "identity": { "name": "Ada Lovelace", "email": "ada@example.com" },
 *   "trailerPrefix": "Myproj",
 *   "planDoc": "PLAN-SPRINT-3.md",
 *   "stateFile": ".slice-build-state.json",
 *   "sacredConstraints": ["Never write under ~/.config/app/data/ (read-only source of truth)"],
 *   "defaultTestCommand": "npm test",
 *   "defaultInstallCheck": "npm pack --dry-run",
 *   "packageCommand": "npm pack",
 *   "visualReference": "docs/design/README.md and the screenshots under docs/design/reference/",
 *   "perSliceFloor": 300000,
 *   "maxFixRounds": 3,
 *   "councilMinConfidence": 0.6,
 *   "securityCouncil": {
 *     "trailerId": "sprint-3",
 *     "beforeSliceId": "release",
 *     "baselineRef": "v0.2.0",
 *     "issue": 42,
 *     "changeSetLabel": "sprint 3",
 *     "maxRounds": 3,
 *     "extraLenses": [
 *       { "key": "webview-xss", "prompt": "Untrusted content rendered in webviews: verify the CSP, the nonce, and that every interpolated string is escaped." }
 *     ]
 *   },
 *   "slices": [
 *     { "id": "search-index", "order": 0, "issue": 12,
 *       "testCommand": "npm test", "installCheck": "npm pack --dry-run",
 *       "goal": "...", "files": ["src/search.js"], "smoke": ["..."] }
 *   ]
 * }
 *
 * PORTING CAVEATS (behavior inherited from the upstream engine)
 *   (a) The dirty-tree auto-reset runs only on the FIRST resumed unit; a tree
 *       that goes dirty mid-run between slices is not auto-reset.
 *   (b) lowestMissingOrder assumes completedOrders is contiguous from 0; a
 *       gap resumes at the gap, and anything after it is re-run.
 *   (c) Strictly sequential across slices; there is no parallel slice build.
 *   (d) DECISIONS.md is written at council time but staged only at commit; a
 *       halt between the council and the commit can lose it from the landing.
 *   (e) No-push-to-main, no-force-command, and no --author/GIT_AUTHOR_* /
 *       GIT_COMMITTER_* override guarantees are HOST HOOK guarantees the
 *       prompts merely reference; they are NOT engine-enforced. A host
 *       without those hooks silently loses those protections.
 *   (f) Invoke by scriptPath, not workflow name, to dodge stale caches.
 *   (g) Duplicate same-slice trailers can exist on main from pre-fix history;
 *       the exact-match (id AND order) resume tolerates them.
 *   (h) The default branch 'main' is hardcoded throughout (preflight, landing,
 *       sync); porting to a master/trunk repo requires editing every
 *       occurrence.
 *   (i) securityCouncil.beforeSliceId is de facto REQUIRED when
 *       securityCouncil is set: preflight halts when it matches no slice.
 *
 * Other deliberate deltas from the source, beyond the parameterization above:
 *   - critiqueSchema lens "read-only-data-integrity" was renamed
 *     "sacred-constraint-data-integrity" and category "read-only" renamed
 *     "sacred-constraint" (same schema shape; the safety-floor filter was
 *     updated to match).
 *   - handoffSchema key "vsixPath" was renamed "artifactPath" (same shape),
 *     and handoffSchema gained a REQUIRED boolean "noop": a re-invoked run
 *     whose handoff already landed reports noop true with nothing to commit,
 *     and the handoff gate accepts pushed/verifiedOnRemote false in that case.
 *   - The security council's silent baselineRef fallback ("v0.0.1") was
 *     removed; securityCouncil.baselineRef is REQUIRED and validated at
 *     startup when the council is configured.
 *   - The engine excludes the orchestration layer's gitignored coordination
 *     path .claude/sprint/ alongside the state file everywhere it ignores its
 *     own state file: the preflight treeClean check, the reset-preserve list,
 *     and the commit-stage porcelain expectation. A tracked-by-accident or
 *     stray file there must never trigger a reset or fail staging.
 *   - The CLASS-SWEEP rule kept its exact operative language; only its
 *     source-history parenthetical (a prior-sprint incident citation) was
 *     dropped.
 *   - The upstream fit-review/council/commit doc conventions are kept as-is:
 *     the engine assumes ARCHITECTURE.md, CHANGELOG.md, DECISIONS.md, and
 *     TESTING.md at the repo root.
 */

export const meta = {
  name: "nest-slice-build",
  description: "Autonomous per-slice build engine for the Claude Code Nest extension: fit review, build, adversarial review loop, independent test gate, PR-per-slice landing (or, with args.localLanding, no-push landing on a local integration branch)",
  phases: [
    { title: "Preflight" },
    { title: "Fit Review" },
    { title: "Council" },
    { title: "Build" },
    { title: "Review" },
    { title: "Fix" },
    { title: "Test" },
    { title: "Commit and Push" },
    { title: "Security Council" },
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
    lens: { type: "string", enum: ["correctness-build-health", "integration-fit", "sacred-constraint-data-integrity", "untrusted-input-security", "visual-fidelity", "completeness"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["title", "severity", "category", "file", "detail", "confidence"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["critical", "major", "minor", "nit"] },
          category: { type: "string", enum: ["correctness", "build", "integration", "sacred-constraint", "data-loss", "security", "visual", "completeness", "other"] },
          file: { type: "string" },
          detail: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        }
      }
    }
  }
};
// Same shape as critiqueSchema but lens is a FREE string: the security council
// runs lenses (path-traversal, deserialization, redos, proto-pollution,
// supply-chain, secrets-pii-public, meta, plus args extraLenses) that are not
// in the slice-review lens enum. A schema-honest security reviewer would fail
// validation against critiqueSchema, return null, and become a synthetic
// critical, so the council could never come back dry. Security path only; the
// slice-review path keeps the enum-locked critiqueSchema above.
const securityCritiqueSchema = {
  type: "object", additionalProperties: false,
  required: ["lens", "summary", "findings"],
  properties: { ...critiqueSchema.properties, lens: { type: "string" } }
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
// openSliceBranches is NEW vs the upstream engine (single-flight guard input; see preflight).
const preflightSchema = {
  type: "object", additionalProperties: false,
  required: ["adopted", "authorOk", "committerOk", "completedOrders", "treeClean", "securityDone", "openSliceBranches", "note"],
  properties: {
    adopted: { type: "boolean" },
    authorOk: { type: "boolean" }, committerOk: { type: "boolean" },
    completedOrders: { type: "array", items: { type: "integer" } },
    treeClean: { type: "boolean" }, securityDone: { type: "boolean" },
    openSliceBranches: { type: "array", items: { type: "string" } },
    note: { type: "string" }
  }
};
const handoffSchema = {
  type: "object", additionalProperties: false,
  required: ["packaged", "artifactPath", "testingDocWritten", "pushed", "verifiedOnRemote", "noop"],
  properties: {
    packaged: { type: "boolean" }, artifactPath: { type: "string" }, testingDocWritten: { type: "boolean" },
    pushed: { type: "boolean" }, verifiedOnRemote: { type: "boolean" }, noop: { type: "boolean" }
  }
};

class HaltError extends Error {
  constructor(message, context) { super(message); this.name = "HaltError"; this.context = context; }
}
// WARNING: later sprints MUST pass args.planDoc explicitly or the councils and
// the handoff read the wrong plan document. The default is only right for the
// first sprint of a repo that actually keeps its plan in PLAN.md.
let PLAN_DOC = "PLAN.md"; // overridden from args.planDoc in main
let STATE_FILE = ".slice-build-state.json"; // overridden from args.stateFile in main
// Landing mode. Default mode (localLanding false) keeps every template prompt as-is, with LANDING_REF
// "origin/main". Local mode lands on INTEGRATION_BRANCH and never pushes or writes to GitHub; LANDING_REF
// is then the integration branch. Set from args in main.
let LOCAL_LANDING = false;
let INTEGRATION_BRANCH = "main";
let LANDING_REF = "origin/main";
const BRANCH_NAME_RE = /^[A-Za-z0-9._\/-]+$/;
// Local mode only: the preflight schema plus a branchExists flag. Default mode keeps preflightSchema unchanged.
const preflightSchemaLocal = {
  ...preflightSchema,
  required: [...preflightSchema.required, "branchExists"],
  properties: { ...preflightSchema.properties, branchExists: { type: "boolean" } }
};
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
    "Write the build resume-state file " + STATE_FILE + " at the repo root with this exact JSON " +
    "and nothing else: " + JSON.stringify({ sliceId: slices[i] ? slices[i].id : null, sliceOrder: i, stage, payload }) +
    ". Ensure " + STATE_FILE + " is in .gitignore (add it if missing). Do not stage, commit, or push. " +
    "Do not modify any other file.",
    { label: "persist-state" }
  );
}
async function runCouncil(slice, fit) {
  const angles = [
    "the simplest resolution that still ships a working slice",
    "the most robust resolution against the binding design rules, the sacred project constraints, and data integrity",
    "the resolution most faithful to " + PLAN_DOC + " and ARCHITECTURE.md"
  ];
  const proposals = await parallel(angles.map((a, idx) => () =>
    agent("DESIGN COUNCIL proposer " + (idx + 1) + ". A fit review flagged this design fork for slice " +
      slice.id + ":\n" + fit.summary + "\nRead ARCHITECTURE.md and " + PLAN_DOC + " (read-only). Propose " + a +
      ". State the concrete decision and its trade-offs.",
      { label: "council-propose-" + (idx + 1) + ":" + slice.id, phase: "Council" })));
  // Fail closed: with zero surviving proposals the judge would be
  // adjudicating an empty set and could fabricate a design.
  const liveProposals = proposals.filter(Boolean);
  if (liveProposals.length === 0) {
    throw new HaltError("All design council proposers died for slice " + slice.id, { stage: "council", slice: slice.id });
  }
  return await agent(
    "DESIGN COUNCIL judge for slice " + slice.id + ". The fork: " + fit.summary + "\nThree proposals:\n" +
    JSON.stringify(liveProposals) + "\nPick the best or synthesize. Return chosen, rationale, " +
    "confidence 0..1 (honest; low means a human should decide), irreversible (true if the choice cannot be " +
    "cheaply undone or risks data loss or a sacred project constraint), and a planPatch to apply before build.",
    { schema: councilDecisionSchema, label: "council-judge:" + slice.id, phase: "Council" });
}
// The 7 generic security lenses. The upstream engine carried 3 more
// project-specific lenses (webview XSS, a read-only filesystem boundary, and
// a sync data-loss class); supply equivalents for YOUR project through
// args.securityCouncil.extraLenses.
const GENERIC_SECURITY_LENSES = [
  { key: "path-traversal", name: "path traversal / arbitrary write", detail: "Every filesystem write target derived from user-chosen or external input. Flag any write target derived from untrusted input without a path guard, and any '..' or absolute-path escape." },
  { key: "deserialization", name: "deserialization / parser safety", detail: "Every load or parse of persisted, imported, or external data. Flag eval, the Function constructor, unsafe JSON handling, or trusting parsed shapes without validation." },
  { key: "redos", name: "ReDoS", detail: "Every regex run over large or user-controlled text, and any regex built from user input. Flag catastrophic-backtracking patterns and user-controlled regex." },
  { key: "proto-pollution", name: "prototype pollution", detail: "Every JSON merge, normalize, or import path and any object key assigned from parsed data. Flag __proto__, constructor, and prototype key paths and unsafe deep merges." },
  { key: "supply-chain", name: "supply chain", detail: "Every new or updated dependency in the change set: pinned version, lockfile integrity, transitive deps, license, and exactly what dependency code ships in the packaged artifact. Flag an unpinned or surprising dependency surface." },
  { key: "secrets-pii-public", name: "secrets, PII, and public-repo exposure", detail: "Assume the repo may be PUBLIC. Flag any secret, token, API key, or credential in committed files OR git history; any real user data or personal data in test fixtures or committed artifacts (fixtures MUST be synthetic); and anything sensitive that would land in a world-readable commit message, issue, PR, or release. Confirm no unexpected telemetry or network calls. Treat a leaked username or absolute path as a lower-severity hygiene note when authorship is already public." },
  { key: "meta", name: "completeness / meta", detail: "What the other lenses missed: message and event handler validation, missing input validation, and repo hygiene (committed build artifacts, package-ignore coverage, anything sensitive shipped in the packaged artifact)." }
];
async function runSecurityCouncil(cfg, floor, lenses, testCommand, sacredText) {
  let round = 0;
  while (true) {
    round += 1;
    phase("Security Council");
    const reviews = await parallel(lenses.map((L) => () =>
      agent("SECURITY COUNCIL reviewer, lens " + L.name + ". REFUTE the safety of the entire " +
        (cfg.changeSetLabel || "sprint") + " change set: diff " + LANDING_REF + " against the baseline ref '" +
        cfg.baselineRef + "' and read the changed files. Lens focus: " + L.detail + " " + sacredText +
        "Report findings; mark an exploitable issue severity critical and a likely-but-unproven one major. " +
        "For every finding, also name its sibling class (every equivalent boundary carrying the same flaw " +
        "pattern) so the fix pass can sweep the class, not the instance. Also return lens: '" + L.key +
        "', and summary: a one-line verdict for this lens. Round " + round + ".",
        { schema: securityCritiqueSchema, label: "sec-" + L.key + ":r" + round, phase: "Security Council" })));
    const findings = aggregateFindings(reviews);
    const actionable = findings.filter(f => f.severity === "critical" || f.severity === "major");
    if (actionable.length === 0) return { dry: true, round };
    if (round > (cfg.maxRounds || 3)) return { dry: false, round, actionable };
    if (budget.total && budget.remaining() <= floor) return { dry: false, round, actionable, budget: true };
    const fix = await agent("SECURITY FIX PASS (round " + round + "). Resolve ALL of these security findings, then " +
      "rebuild and run the test suite ('" + testCommand + "'). Keep any scratch under .claude-working/ only, never " +
      "under source or build-output directories. Do NOT commit or push. Report summary (one line), " +
      "buildPasses, testsPass, and remainingFindings. Findings:\n" + JSON.stringify(actionable),
      { schema: fixResultSchema, label: "sec-fix:r" + round, phase: "Security Council" });
    if (fix == null) return { dry: false, round, actionable, fixDied: true };
  }
}

// ---------------- main ----------------
try {
  phase("Preflight");
  // The harness can deliver args as a JSON-encoded string; coerce to an object.
  const A = (args && typeof args === "string") ? JSON.parse(args) : (args || {});

  // ---- Landing-mode args (validated first: later halt messages name the effective landing ref) ----
  if (A.localLanding != null && typeof A.localLanding !== "boolean") {
    throw new HaltError("args.localLanding must be a boolean (default false).", { stage: "preflight" });
  }
  if (A.integrationBranch != null
      && (typeof A.integrationBranch !== "string" || !BRANCH_NAME_RE.test(A.integrationBranch) || A.integrationBranch.startsWith("-"))) {
    throw new HaltError("args.integrationBranch must be a string matching /^[A-Za-z0-9._\\/-]+$/ and must not start with '-' (default \"main\").", { stage: "preflight" });
  }
  LOCAL_LANDING = A.localLanding === true;
  if (LOCAL_LANDING) {
    INTEGRATION_BRANCH = (A.integrationBranch != null) ? A.integrationBranch : "main";
    if (INTEGRATION_BRANCH === "main") {
      throw new HaltError("args.integrationBranch must not be \"main\" when args.localLanding is true: local landing never touches main.", { stage: "preflight" });
    }
    LANDING_REF = INTEGRATION_BRANCH;
  } else {
    INTEGRATION_BRANCH = "main";
    LANDING_REF = "origin/main";
  }

  // ---- Required-arg validation (fail loudly at startup; never hardcode a person or a project) ----
  if (!A.identity || typeof A.identity.name !== "string" || A.identity.name.trim() === "") {
    throw new HaltError("args.identity.name is REQUIRED: pass identity {name, email} for the sole allowed git author/committer.", { stage: "preflight" });
  }
  if (typeof A.identity.email !== "string" || A.identity.email.trim() === "") {
    throw new HaltError("args.identity.email is REQUIRED: pass identity {name, email} for the sole allowed git author/committer.", { stage: "preflight" });
  }
  if (typeof A.trailerPrefix !== "string" || A.trailerPrefix.trim() === "") {
    throw new HaltError("args.trailerPrefix is REQUIRED and must be non-empty (e.g. \"Myproj\"): it prefixes the '<prefix>-Slice:' and '<prefix>-Security:' commit trailers.", { stage: "preflight" });
  }
  if (A.securityCouncil && (typeof A.securityCouncil.trailerId !== "string" || A.securityCouncil.trailerId.trim() === "")) {
    // The upstream engine fell back to a hardcoded sprint id here; that fallback is removed on purpose.
    throw new HaltError("args.securityCouncil.trailerId is REQUIRED when args.securityCouncil is set: it names the '<prefix>-Security: <trailerId> (audit)' trailer.", { stage: "preflight" });
  }
  if (A.securityCouncil && (typeof A.securityCouncil.baselineRef !== "string" || A.securityCouncil.baselineRef.trim() === "")) {
    // The upstream engine silently fell back to a hardcoded tag here; a missing ref must not silently diff against a nonexistent tag.
    throw new HaltError("args.securityCouncil.baselineRef is REQUIRED when args.securityCouncil is set: the security council diffs " + LANDING_REF + " against this ref.", { stage: "preflight" });
  }
  const IDENT_NAME = A.identity.name.trim();
  const IDENT_EMAIL = A.identity.email.trim();
  const TRAILER_PREFIX = A.trailerPrefix.trim();

  const slices = (A && Array.isArray(A.slices)) ? A.slices : [];
  if (slices.length === 0) throw new HaltError("No slices in args.slices", { stage: "preflight" });
  const orders = slices.map(s => s.order);
  for (let i = 0; i < slices.length; i++) {
    if (!orders.includes(i)) throw new HaltError("slice orders must be contiguous 0..n-1", { stage: "preflight", orders });
  }
  slices.sort((a, b) => a.order - b.order);
  // Duplicate slice ids would collide on the slice/<id> branch name across orders.
  const seenIds = new Set();
  for (const s of slices) {
    if (seenIds.has(s.id)) throw new HaltError("duplicate slice id '" + s.id + "' in args.slices", { stage: "preflight" });
    seenIds.add(s.id);
  }

  // PER_SLICE_FLOOR unit is OUTPUT TOKENS, per the Workflow harness budget
  // contract (budget.total / budget.remaining() count output tokens). Default 300000.
  // 300000 and maxFixRounds 3 were calibrated on the Nest builds under the
  // pre-Opus model; re-baseline on the first Opus sprint.
  const PER_SLICE_FLOOR = (A && A.perSliceFloor != null) ? A.perSliceFloor : 300000;
  const MAX_FIX_ROUNDS = (A && A.maxFixRounds != null) ? A.maxFixRounds : 3;
  const COUNCIL_MIN = (A && A.councilMinConfidence != null) ? A.councilMinConfidence : 0.6;
  const RUN_HANDOFF = (A && A.runHandoff != null) ? A.runHandoff : true;
  PLAN_DOC = (A && A.planDoc) ? A.planDoc : "PLAN.md"; // WARNING: later sprints MUST pass args.planDoc (see header)
  STATE_FILE = (A && A.stateFile) ? A.stateFile : ".slice-build-state.json";
  const DEFAULT_TEST = (A && A.defaultTestCommand) ? A.defaultTestCommand : "npm test";
  // The upstream engine hardcoded its extension-packaging command as the
  // install-check fallback; there is no safe generic default, so require one.
  const DEFAULT_INSTALL = (A && A.defaultInstallCheck) ? A.defaultInstallCheck : null;
  for (const s of slices) {
    if (!s.installCheck && !DEFAULT_INSTALL) {
      throw new HaltError("Slice '" + s.id + "' has no installCheck and args.defaultInstallCheck is unset: pass an install/package check command (per slice or as the default).", { stage: "preflight" });
    }
  }
  const PACKAGE_CMD = (A && A.packageCommand) ? A.packageCommand : null;
  const VISUAL_REF = (A && A.visualReference) ? A.visualReference : "the project's binding design reference docs and reference screenshots";
  const SACRED = (A && Array.isArray(A.sacredConstraints)) ? A.sacredConstraints : [];
  const SACRED_TEXT = SACRED.length
    ? "Sacred project constraints (violating any one is a critical finding): " + SACRED.join("; ") + ". "
    : "";
  const securityCfg = (A && A.securityCouncil) ? A.securityCouncil : null;
  const SEC_ID = securityCfg ? securityCfg.trailerId.trim() : null;
  const SEC_TRAILER = securityCfg ? (TRAILER_PREFIX + "-Security: " + SEC_ID + " (audit)") : null;
  const SECURITY_LENSES = securityCfg
    ? GENERIC_SECURITY_LENSES.concat((Array.isArray(securityCfg.extraLenses) ? securityCfg.extraLenses : [])
        .map(x => ({ key: x.key, name: x.key, detail: x.prompt })))
    : GENERIC_SECURITY_LENSES;

  // Resume detection must key on THIS run's exact id+order trailers, not order alone: a prior sprint can have
  // landed orders 0..n on origin/main, so counting any slice trailer by order would mark this run done.
  const expectedTrailers = slices.map(s => TRAILER_PREFIX + "-Slice: " + s.id + " (" + s.order + ")").join("; ");

  // ---- Landing-mode prompt fragments. Each returns the template's exact text in default mode; in local mode
  // it returns the no-push variant that lands on INTEGRATION_BRANCH. Call sites below only concatenate them. ----
  const B = INTEGRATION_BRANCH;
  const NO_REMOTE_WRITES = "NEVER run git push, gh pr create, gh pr merge, or any other gh command that writes, " +
    "and NEVER check out or merge into main. ";
  function pfFetchText() {
    if (!LOCAL_LANDING) {
      return "Then run 'git fetch origin' (read-only; updates " +
        "remote-tracking refs only, does not touch the working tree). ";
    }
    return "Do NOT run 'git fetch' or contact any remote (this run is local-only). Also return branchExists: " +
      "true only if the local branch '" + B + "' exists (git rev-parse --verify --quiet refs/heads/" + B + "). ";
  }
  function pfVerifyText() {
    if (!LOCAL_LANDING) return "Verify against origin/main with git log origin/main, not just local log. ";
    return "Verify against the local integration branch with git log " + B + " (it is the only source of truth in " +
      "this run; do not consult any remote). ";
  }
  function pfOpenBranchesText() {
    if (!LOCAL_LANDING) {
      return "5) openSliceBranches: list every remote branch matching 'slice/*' (git branch -r after the fetch) and the " +
        "head branch of every OPEN pull request whose head matches 'slice/*' (gh pr list --state open), EXCLUDING " +
        "branches named exactly 'slice/<id>' for the slice ids in this run's trailer list above AND ALWAYS " +
        "excluding 'slice/handoff' (this run's own handoff branch, both as a remote branch and as a PR head; a " +
        "halted handoff must not deadlock the re-invoke); report the leftover names (empty array if none). ";
    }
    return "5) openSliceBranches: list every LOCAL branch matching 'slice/*' that is not yet merged into '" + B +
      "' (git branch --no-merged " + B + " --list 'slice/*'; strip the leading marker characters), EXCLUDING " +
      "branches named exactly 'slice/<id>' for the slice ids in this run's trailer list above AND ALWAYS " +
      "excluding 'slice/handoff' (this run's own handoff branch; a halted handoff must not deadlock the " +
      "re-invoke). Do NOT run gh pr list or any other gh command and do not look at remote branches; report " +
      "the leftover names (empty array if none). ";
  }
  function singleFlightMessage(list) {
    if (!LOCAL_LANDING) {
      return "Open slice/* branches or PRs exist that do not belong to this run's slices (" +
        list.join(", ") + "); another run may be active. Resolve or delete them before re-invoking.";
    }
    return "Unmerged local slice/* branches exist that do not belong to this run's slices (" + list.join(", ") +
      "); another run may be active or a halted attempt left work. Resolve or delete them before re-invoking.";
  }
  function resetTreePrompt(slice) {
    const stash = "Set aside " +
      "uncommitted working changes with 'git stash -u' ONLY (this preserves " + STATE_FILE + ", the " +
      ".claude/sprint/ coordination directory, and gitignored paths; never delete anything under " +
      ".claude/sprint/). Stashing preserves uncommitted plan/research docs, which a fresh install may " +
      "legitimately have. ";
    if (!LOCAL_LANDING) {
      return "Restore a clean working tree for a resumed build WITHOUT any force command (git reset --hard, " +
        "git checkout -f, and git branch -f are all blocked by the hook). 1) 'git fetch origin'. 2) " + stash + "3) 'git checkout main' then " +
        "'git merge --ff-only origin/main' to advance main to the latest merged commit. 4) Best-effort delete " +
        "leftover merged slice/* branches with 'git branch -d' (ignore failures). Confirm git status " +
        "--porcelain is empty except the state file and anything under .claude/sprint/. Do not push.";
    }
    return "Restore a clean working tree for a resumed build WITHOUT any force command (git reset --hard, " +
      "git checkout -f, and git branch -f are all blocked by the hook). 1) Do NOT run 'git fetch' or contact any " +
      "remote; this run is local-only. 2) " + stash + "3) 'git checkout " + B + "' (no fetch, no fast-forward " +
      "from origin; never check out or merge into main). 4) Best-effort delete leftover merged slice/* branches " +
      "with 'git branch -d' (ignore failures). Also, if a local branch 'slice/" + slice.id + "' exists and its " +
      "trailer '" + TRAILER_PREFIX + "-Slice: " + slice.id + " (" + slice.order + ")' is NOT on '" + B +
      "' (check with git log " + B + "), delete it with 'git branch -D slice/" + slice.id + "' (ignore failure); " +
      "if that trailer IS on '" + B + "', keep the branch. Confirm git status " +
      "--porcelain is empty except the state file and anything under .claude/sprint/. Do not push.";
  }
  function buildBranchText(slice) {
    if (!LOCAL_LANDING) return "";
    return "Branch base: do all work on branch 'slice/" + slice.id + "' created from the tip of the local " +
      "integration branch '" + B + "'. If a local 'slice/" + slice.id + "' branch already exists and its " +
      "trailer is NOT on '" + B + "', delete it with 'git branch -D slice/" + slice.id + "' first; then run " +
      "'git checkout -b slice/" + slice.id + " " + B + "' (uncommitted files such as DECISIONS.md carry over). " +
      "Never touch main and never push. ";
  }
  function fixBranchText(slice) {
    if (!LOCAL_LANDING) return "";
    return " Stay on branch 'slice/" + slice.id + "' (created from '" + B + "'); do not switch branches.";
  }
  function commitPrompt(slice, mergedPlan, test) {
    const stepsOneToThree = "1) Update ARCHITECTURE.md (fold in " +
      "accepted patches: " + JSON.stringify(mergedPlan.patches) + "), add a CHANGELOG entry for slice " +
      slice.id + ", and stage DECISIONS.md if it changed. 2) git status --porcelain: confirm only expected " +
      "slice files plus ARCHITECTURE.md, CHANGELOG.md, and DECISIONS.md changed; " + STATE_FILE + " and " +
      "anything under .claude/sprint/ (the orchestration layer's coordination directory) must be excluded " +
      "and never staged. 3) Re-verify effective git user.name is '" + IDENT_NAME + "' and user.email " +
      "'" + IDENT_EMAIL + "' so author and committer are BOTH " + IDENT_NAME + ". Do NOT use the --author flag " +
      "or GIT_AUTHOR_*/GIT_COMMITTER_* env overrides; the hook blocks them and the local config already makes " +
      "both correct. ";
    if (!LOCAL_LANDING) {
      return "COMMIT this slice and land it on main via a pull request (direct pushes to main are blocked by a " +
        "safety hook; the PR-then-merge flow is the sanctioned path). " + stepsOneToThree +
        "If a branch 'slice/" + slice.id + "' already exists locally or on origin from a halted " +
        "prior attempt (its " + TRAILER_PREFIX + "-Slice trailer is NOT on origin/main), delete it first: " +
        "'git branch -D slice/" + slice.id + "' locally and 'git push origin --delete slice/" + slice.id + "' " +
        "on the remote (ignore either failing because the branch is absent). Then create the branch fresh: " +
        "'git checkout -b slice/" + slice.id + "' (this " +
        "carries the uncommitted build changes onto the branch, leaving main clean), and commit there. Subject " +
        "imperative, under 70 chars, no emoji, no em or en dashes, NO AI co-author trailer, NO generated-by " +
        "marker. Append trailer '" + TRAILER_PREFIX + "-Slice: " + slice.id + " (" + slice.order + ")'. 4) Push the branch with " +
        "'git push -u origin slice/" + slice.id + "', open a PR into main with 'gh pr create --base main --head " +
        "slice/" + slice.id + " --title <subject> --body <short body" + (slice.issue ? "; the body MUST contain " +
        "a line 'Fixes #" + slice.issue + "' so the merge closes the slice issue" : "") + ">'. " +
        (slice.issue ? "Before merging, post the independent test evidence as a comment on issue #" + slice.issue +
        " ('gh issue comment " + slice.issue + " --body <evidence>') containing: the test command '" +
        (test.command || slice.testCommand || DEFAULT_TEST) + "', exit code " + test.exitCode + ", the output tail (" +
        JSON.stringify(String(test.output || "").slice(-400)) + "), the install check '" +
        (slice.installCheck || DEFAULT_INSTALL) + "', and the PR url. Status transitions carry evidence, not " +
        "claims. " : "") + "Then merge it with a MERGE COMMIT so the " +
        "slice commit lands on main unchanged: 'gh pr merge --merge --delete-branch' (pass the PR number or url; " +
        "if the merge fails with a transient mergeability error, wait about 10 seconds and retry once before " +
        "reporting failure). NEVER put 'git push' and the word main in the SAME shell command; run them as " +
        "separate commands. " +
        "Do NOT push to main directly. 5) Sync local main WITHOUT any force command (git reset --hard is blocked " +
        "by the hook): 'git fetch origin', 'git checkout main', then 'git merge --ff-only origin/main' (local " +
        "main is strictly behind origin/main after the merge, so this fast-forwards cleanly). 6) VERIFY: the " +
        "slice commit carrying the " + TRAILER_PREFIX + "-Slice trailer is now on " +
        "origin/main (git log origin/main), and on THAT slice commit the author is '" + IDENT_NAME + " " +
        "<" + IDENT_EMAIL + ">' and the committer is the same. Report committed, pushed, verifiedOnRemote (true " +
        "only if the trailer commit is on origin/main), sha (the slice commit sha), authorVerified, and " +
        "committerVerified (both checked on the slice commit, not the GitHub merge commit).";
    }
    const trailer = TRAILER_PREFIX + "-Slice: " + slice.id + " (" + slice.order + ")";
    return "COMMIT this slice and land it on the LOCAL integration branch '" + B + "' with a merge commit (this run " +
      "never pushes and never writes to GitHub: no push, no PR, no issue comment). " + stepsOneToThree +
      "You should already be on branch 'slice/" + slice.id + "' (created from the tip of '" + B + "' during " +
      "build); confirm with 'git branch --show-current'. If that branch does not exist yet, create it with " +
      "'git checkout -b slice/" + slice.id + " " + B + "' (this carries the uncommitted build changes onto the " +
      "branch). Commit there. Subject imperative, under 70 chars, no emoji, no em or en dashes, NO AI co-author " +
      "trailer, NO generated-by marker. Append trailer '" + trailer + "' as the ONLY line of the commit " +
      "message's FINAL paragraph: no other text in that paragraph (a colon-less line there makes git reject the " +
      "ENTIRE trailer block, and preflight then treats the slice as unbuilt and rebuilds it). " +
      (slice.issue
        ? "Put no Fixes line in the commit; the driver adds 'Fixes #" + slice.issue + "' to the PR body later. "
        : "Put no Fixes line in the commit. ") +
      "After committing, verify the trailer PARSES: git log -1 --format='%(trailers:key=" + TRAILER_PREFIX +
      "-Slice,valueonly)' must print exactly '" + slice.id + " (" + slice.order + ")'; if it prints nothing, " +
      "amend the message before merging. 4) Land it locally and ONLY locally: 'git checkout " + B + "' then " +
      "'git merge --no-ff --no-edit slice/" + slice.id + "'. Keep the branch 'slice/" + slice.id + "' (do NOT " +
      "delete it). " + NO_REMOTE_WRITES + "5) VERIFY: the slice commit carrying the " + TRAILER_PREFIX +
      "-Slice trailer is now reachable from '" + B + "' (git log " + B + " --format='%(trailers:key=" +
      TRAILER_PREFIX + "-Slice,valueonly)'; the trailer must PARSE there), and on THAT slice commit the author " +
      "is '" + IDENT_NAME + " <" + IDENT_EMAIL + ">' and the committer is the same. Report committed (true once " +
      "the slice commit exists), pushed (ALWAYS false: nothing is pushed in this run), verifiedOnRemote (true " +
      "only if the trailer commit is reachable from '" + B + "'; the field name is kept for the schema but it " +
      "checks the LOCAL branch), sha (the slice commit sha), authorVerified, and committerVerified (both " +
      "checked on the slice commit, not the merge commit).";
  }
  function securityLandPrompt() {
    if (!LOCAL_LANDING) {
      return "Land the pre-release security audit on main via a PR. If the council made code fixes the working tree has " +
        "changes: stage them and add a CHANGELOG note (and update ARCHITECTURE.md if a binding contract changed). " +
        "If there were NO code fixes, still create a marker by appending a dated 'Security audit: no actionable " +
        "findings' line under the CHANGELOG.md [Unreleased] section. Either way commit as " + IDENT_NAME + " via " +
        "local git config (NO --author, NO GIT_AUTHOR_*/GIT_COMMITTER_* overrides, NO AI co-author trailer; " +
        "subject under 70 chars; no em or en dashes; no emoji) with the trailer '" + SEC_TRAILER + "'. If the " +
        "branch 'security/" + SEC_ID + "-audit' already exists locally or on origin from a halted prior attempt " +
        "(its " + TRAILER_PREFIX + "-Security trailer is NOT on origin/main), delete it first: " +
        "'git branch -D security/" + SEC_ID + "-audit' locally and 'git push origin --delete security/" +
        SEC_ID + "-audit' on the remote (ignore either failing because the branch is absent). Then create " +
        "branch 'security/" + SEC_ID + "-audit' fresh, push it, open a PR with 'gh pr create --base main', merge with " +
        "'gh pr merge --merge --delete-branch' (if the merge fails with a transient mergeability error, wait " +
        "about 10 seconds and retry once before reporting failure), then sync local main with 'git fetch origin' " +
        "+ 'git checkout main' + 'git merge --ff-only origin/main'. NEVER put 'git push' and the word main in " +
        "the SAME shell command; run them as separate commands. " +
        (securityCfg.issue ? "The PR body must include 'Fixes #" + securityCfg.issue + "'. " : "") +
        "Verify the " + TRAILER_PREFIX + "-Security trailer commit is on origin/main, authored and committed by " +
        IDENT_NAME + ". Report committed, pushed, verifiedOnRemote, sha, authorVerified, committerVerified.";
    }
    return "Land the pre-release security audit on the LOCAL integration branch '" + B + "' (no push, no PR, no " +
      "GitHub writes). If the council made code fixes the working tree has " +
      "changes: stage them and add a CHANGELOG note (and update ARCHITECTURE.md if a binding contract changed). " +
      "If there were NO code fixes, still create a marker by appending a dated 'Security audit: no actionable " +
      "findings' line under the CHANGELOG.md [Unreleased] section. Either way commit as " + IDENT_NAME + " via " +
      "local git config (NO --author, NO GIT_AUTHOR_*/GIT_COMMITTER_* overrides, NO AI co-author trailer; " +
      "subject under 70 chars; no em or en dashes; no emoji) with the trailer '" + SEC_TRAILER + "' as the ONLY " +
      "line of the commit message's FINAL paragraph (put no Fixes line in the commit; the driver handles the " +
      "issue link in the PR body later). If the branch 'security/" + SEC_ID + "-audit' already exists locally " +
      "from a halted prior attempt (its " + TRAILER_PREFIX + "-Security trailer is NOT on '" + B + "'), delete " +
      "it first with 'git branch -D security/" + SEC_ID + "-audit' (ignore failure because the branch is absent). " +
      "Then create branch 'security/" + SEC_ID + "-audit' fresh from the tip of '" + B + "' with 'git checkout -b " +
      "security/" + SEC_ID + "-audit " + B + "' (this carries the uncommitted council fixes), commit there, then " +
      "'git checkout " + B + "' and 'git merge --no-ff --no-edit security/" + SEC_ID + "-audit'. Keep the branch " +
      "(do NOT delete it). " + NO_REMOTE_WRITES + "Verify the " + TRAILER_PREFIX + "-Security trailer commit " +
      "is reachable from '" + B + "' (git log " + B + "), authored and committed by " + IDENT_NAME + ". Report " +
      "committed, pushed (ALWAYS false: nothing is pushed in this run), verifiedOnRemote (true only if the " +
      "trailer commit is reachable from '" + B + "'; it checks the LOCAL branch), sha, authorVerified, " +
      "committerVerified.";
  }
  function handoffStep4Text() {
    if (!LOCAL_LANDING) {
      return "4) Before landing, delete any leftover 'slice/handoff' branch from a prior halted attempt: " +
        "'git branch -D slice/handoff' locally and 'git push origin --delete slice/handoff' on the remote " +
        "(ignore either failing because the branch is absent). If the docs are already current and there is " +
        "NOTHING to commit (a prior completed run already landed this handoff), do NOT create a branch or PR and " +
        "do NOT make an empty commit: report success with noop true (pushed and verifiedOnRemote may then be " +
        "false). Otherwise report noop false and land it on main via a PR (direct pushes to main are blocked): " +
        "commit on a branch 'slice/handoff' " +
        "with author and committer both " + IDENT_NAME + " (local config; no --author flag, no AI trailer, no " +
        "generated-by marker, no em or en dashes, no emoji). If unrelated uncommitted changes exist in the tree, " +
        "'git stash -u' them first. Stage ONLY README.md, CHANGELOG.md, and TESTING.md (plus any file the " +
        "packaging step must commit), and confirm with git status --porcelain that nothing else is staged. " +
        "Push the branch, open a PR into main with gh, merge it " +
        "with 'gh pr merge --merge --delete-branch' (if the merge fails with a transient mergeability error, wait " +
        "about 10 seconds and retry once before reporting failure), then 'git fetch origin', 'git checkout main', and " +
        "'git merge --ff-only origin/main' (do NOT use git reset --hard; it is blocked) and verify the handoff " +
        "commit is on origin/main. Do NOT push to main directly. NEVER put 'git push' and the word main in the " +
        "SAME shell command; run them as separate commands. Report packaged, " +
        "artifactPath, testingDocWritten, pushed, verifiedOnRemote, and noop (true only for the nothing-to-commit case).";
    }
    return "4) Before landing, delete any leftover 'slice/handoff' branch from a prior halted attempt: " +
      "'git branch -D slice/handoff' locally (ignore failure because the branch is absent). If the docs are " +
      "already current and there is NOTHING to commit (a prior completed run already landed this handoff), do " +
      "NOT create a branch and do NOT make an empty commit: report success with noop true (verifiedOnRemote may " +
      "then be false). Otherwise report noop false and land it on the LOCAL integration branch '" + B + "' (no " +
      "push, no PR, no tag, no release): create branch 'slice/handoff' from the tip of '" + B + "' with 'git " +
      "checkout -b slice/handoff " + B + "' and commit there with author and committer both " + IDENT_NAME +
      " (local config; no --author flag, no AI trailer, no generated-by marker, no em or en dashes, no emoji). " +
      "If unrelated uncommitted changes exist in the tree, 'git stash -u' them first. Stage ONLY README.md, " +
      "CHANGELOG.md, and TESTING.md (plus any file the packaging step must commit), and confirm with git status " +
      "--porcelain that nothing else is staged. Then 'git checkout " + B + "' and 'git merge --no-ff --no-edit " +
      "slice/handoff', keep the branch (do NOT delete it), and verify the handoff commit is reachable from '" +
      B + "' (git log " + B + "). " + NO_REMOTE_WRITES + "Also never create a tag or a release. Report packaged, " +
      "artifactPath, testingDocWritten, pushed (ALWAYS false: nothing is pushed in this run), verifiedOnRemote " +
      "(true only if the handoff commit is reachable from '" + B + "'; it checks the LOCAL branch), and noop " +
      "(true only for the nothing-to-commit case).";
  }
  const LANDED_BRANCH = LOCAL_LANDING ? B : "main";
  const commitFailPrefix = LOCAL_LANDING ? "Commit/merge/verify failed for " : "Commit/push/verify failed for ";
  const landedLogText = LOCAL_LANDING ? " committed and merged locally into " + B + ": " : " committed and pushed: ";
  // Gates. Default mode keeps the template conditions; local mode requires the local merge and a pushed:false report.
  function landingFailed(r) {
    if (!LOCAL_LANDING) {
      return r == null || !r.committed || !r.pushed || !r.verifiedOnRemote || !r.authorVerified || !r.committerVerified;
    }
    return r == null || !r.committed || r.pushed !== false || !r.verifiedOnRemote || !r.authorVerified || !r.committerVerified;
  }
  function handoffFailed(h) {
    if (!LOCAL_LANDING) {
      return h == null
        || (h.noop !== true && (!h.packaged || !h.testingDocWritten || !h.pushed || !h.verifiedOnRemote));
    }
    return h == null || h.pushed === true
      || (h.noop !== true && (!h.packaged || !h.testingDocWritten || !h.verifiedOnRemote));
  }

  const pf = await agent(
    "Read-only preflight at the repo root. First: adopted must be true ONLY if the file " +
    ".claude/advanced-sprint-ops.md exists at the repo toplevel (check with " +
    "test -f \"$(git rev-parse --show-toplevel)/.claude/advanced-sprint-ops.md\"); this is the adoption marker " +
    "that authorizes this engine to operate in this repo. " + pfFetchText() +
    "1) Report authorOk true only if effective git user.name is " +
    "exactly '" + IDENT_NAME + "' and user.email exactly '" + IDENT_EMAIL + "' (local overrides global; report " +
    "the EFFECTIVE values), and committerOk the same way. 2) completedOrders: the EXACT trailers for THIS " +
    "run are [" + expectedTrailers + "]. An order N counts as done ONLY if a commit on " + LANDING_REF + " carries " +
    "that order's EXACT trailer from this list (matching BOTH the id AND the order); a " + TRAILER_PREFIX +
    "-Slice trailer with any OTHER id, such as a prior sprint's, does NOT count toward completedOrders. " +
    pfVerifyText() +
    "3) treeClean from git status --porcelain, ignoring " + STATE_FILE + " and anything under .claude/sprint/ " +
    "(the orchestration layer's coordination directory). 4) securityDone: " +
    (securityCfg
      ? "true if a commit carrying the trailer '" + SEC_TRAILER + "' is present on " + LANDING_REF + ", else false. "
      : "report false (no security council is configured for this run). ") +
    pfOpenBranchesText() +
    "Also return note: a one-line summary of the preflight result. Modify nothing.",
    { schema: LOCAL_LANDING ? preflightSchemaLocal : preflightSchema, label: "preflight", phase: "Preflight" });
  if (pf == null) throw new HaltError("Preflight agent died", { stage: "preflight" });
  // Containment: this engine operates only in a repo that explicitly adopted the advanced
  // sprint suite. Fail closed BEFORE any identity or resume logic so a scriptPath invocation
  // in the wrong repo (or a nested subdir of a client repo) can never build, commit, or push.
  if (pf.adopted !== true) {
    throw new HaltError("This repo has no .claude/advanced-sprint-ops.md adoption marker at its git " +
      "toplevel. The engine refuses to operate in a repo that did not explicitly adopt the advanced " +
      "sprint suite. Run the advanced-sprint-orchestration installer first if adoption is intended.",
      { stage: "preflight", adopted: false });
  }
  if (!pf.authorOk || !pf.committerOk) throw new HaltError("git identity is not " + IDENT_NAME + " <" + IDENT_EMAIL + ">", { stage: "preflight", pf });
  // Local landing needs the integration branch to exist locally; there is no remote fallback.
  if (LOCAL_LANDING && pf.branchExists !== true) {
    throw new HaltError("Integration branch '" + INTEGRATION_BRANCH + "' does not exist locally; create it before " +
      "running with localLanding. The engine never falls back to another branch.",
      { stage: "preflight", integrationBranch: INTEGRATION_BRANCH });
  }
  // NEW vs the upstream engine (see header provenance), unproven in production: single-flight guard.
  // Foreign slice/* branches or open slice/* PRs mean another run may be active on this repo; two
  // concurrent runs would race the tree reset, the PR merges, and the resume trailers. Fail closed.
  // In local landing mode the guard checks only local slice/* branches not yet merged into the integration branch.
  if (Array.isArray(pf.openSliceBranches) && pf.openSliceBranches.length > 0) {
    throw new HaltError(singleFlightMessage(pf.openSliceBranches),
      { stage: "preflight", openSliceBranches: pf.openSliceBranches });
  }

  const startIndex = lowestMissingOrder(pf.completedOrders, slices.length);
  const builtSlices = (pf.completedOrders || []).map(o => (slices[o] ? slices[o].id : String(o)));
  const decisions = [];
  // Opt-in pre-release security council (args.securityCouncil). Runs once, before the named release slice.
  const releaseIdx = securityCfg ? slices.findIndex(s => s.id === securityCfg.beforeSliceId) : -1;
  if (securityCfg && releaseIdx < 0) {
    throw new HaltError("securityCouncil.beforeSliceId '" + securityCfg.beforeSliceId + "' matches no slice", { stage: "preflight", securityCfg });
  }
  let securityRan = false;
  log("Preflight ok. Resuming at slice order " + startIndex + " of " + slices.length + "." +
    (securityCfg ? " Security council armed before slice " + securityCfg.beforeSliceId + (pf.securityDone ? " (already done on " + LANDING_REF + ")." : ".") : ""));

  for (let i = startIndex; i < slices.length; i++) {
    const slice = slices[i];
    log("Slice " + i + "/" + (slices.length - 1) + " (" + slice.id + ")");

    if (budget.total && budget.remaining() <= PER_SLICE_FLOOR) {
      await persistState(slices, i, "budget", {});
      throw new HaltError("Budget floor reached before slice " + slice.id, { stage: "budget", slice: slice.id });
    }
    if (!pf.treeClean && i === startIndex) {
      const reset = await agent(
        resetTreePrompt(slice),
        { label: "reset-tree", phase: "Build" });
      if (reset == null) throw new HaltError("Tree reset agent died on resume", { stage: "reset", slice: slice.id });
    }

    // ---- Pre-release security council (opt-in; once, before the release slice) ----
    if (securityCfg && i === releaseIdx && !pf.securityDone && !securityRan) {
      if (budget.total && budget.remaining() <= PER_SLICE_FLOOR) {
        await persistState(slices, i, "security", {});
        throw new HaltError("Budget floor reached before the security council", { stage: "budget", slice: "security" });
      }
      const sec = await runSecurityCouncil(securityCfg, PER_SLICE_FLOOR, SECURITY_LENSES,
        (slices[releaseIdx].testCommand || DEFAULT_TEST), SACRED_TEXT);
      if (!sec.dry) {
        await persistState(slices, i, "security", { actionable: sec.actionable || [] });
        throw new HaltError("Security council still has actionable findings after the fix loop; not releasing.",
          { stage: "security", actionable: sec.actionable, budgetHit: !!sec.budget, fixDied: !!sec.fixDied });
      }
      const secLand = await agent(
        securityLandPrompt(),
        { schema: commitResultSchema, label: "security-land", phase: "Security Council" });
      if (landingFailed(secLand)) {
        await persistState(slices, i, "security", { secLand });
        throw new HaltError("Security audit landing failed", { stage: "security", secLand });
      }
      securityRan = true;
      log("Security council came back dry; audit landed on " + LANDING_REF + ": " + secLand.sha);
    }

    // ---- Fit review (+ council on a fork) ----
    phase("Fit Review");
    const fit = await agent(
      "FIT REVIEW for the next slice before building. Read ARCHITECTURE.md and the already-built slices [" +
      builtSlices.join(", ") + "]. Slice plan:\n" + JSON.stringify(slice) + "\nFlag drift. Set blocking true " +
      "only if a real design decision is needed to proceed. If small adjustments suffice, return a planPatch. " +
      "Also return summary: a one-line summary of the fit assessment. Read-only; do not edit files.",
      { schema: fitReviewSchema, label: "fit:" + slice.id, phase: "Fit Review" });
    if (fit == null) throw new HaltError("Fit review died for " + slice.id, { stage: "fit", slice: slice.id });

    const patches = [];
    if (fit.planPatch && fit.planPatch.hasPatch) patches.push({ source: "fit", changes: fit.planPatch.changes });
    if (fit.blocking) {
      phase("Council");
      const decision = await runCouncil(slice, fit);
      if (decision == null) {
        await persistState(slices, i, "council", { fit, decision });
        throw new HaltError("Council judge agent died for " + slice.id, { stage: "council", slice: slice.id, fit });
      }
      // Safety floor: an irreversible fork (data loss or a sacred constraint) is NOT auto-resolved. A wrong
      // call there cannot be cheaply undone and would be reviewed only after it had already landed, so a human
      // decides. The judge sets irreversible; the adversarial sacred-constraint-data-integrity lens is the
      // second backstop.
      if (decision.irreversible) {
        await persistState(slices, i, "council", { fit, decision });
        throw new HaltError("Design fork is irreversible (data-loss or sacred-constraint risk); needs a human for " + slice.id,
          { stage: "council", slice: slice.id, fit, decision });
      }
      // Reversible forks proceed on the judge's best option even at low confidence (engine default since
      // 2026-06-19). A wrong reversible call is caught by the adversarial review or undone in a later PR; every
      // such decision is recorded in DECISIONS.md, and low-confidence ones are flagged for post-hoc human review.
      const lowConf = decision.confidence < COUNCIL_MIN;
      decisions.push({ slice: slice.id, fork: fit.summary, chosen: decision.chosen, rationale: decision.rationale,
        confidence: decision.confidence, lowConfidence: lowConf });
      if (decision.planPatch && decision.planPatch.hasPatch) patches.push({ source: "council", changes: decision.planPatch.changes });
      const logged = await agent(
        "Append a dated entry to DECISIONS.md at the repo root (create it if missing) recording this " +
        "autonomous design decision. Entry: slice " + slice.id + "; fork: " + fit.summary + "; chosen: " +
        decision.chosen + "; rationale: " + decision.rationale + "; confidence: " + decision.confidence +
        (lowConf ? " (LOW CONFIDENCE; auto-resolved as reversible, flag for post-hoc human review)" : "") +
        ". Do not stage, commit, or push. No em dashes, en dashes, or emojis.",
        { label: "log-decision:" + slice.id, phase: "Council" });
      if (logged == null) {
        log("WARNING: decisions-log agent died; fork for slice " + slice.id + " recorded only in the run summary");
      }
      log("Council decided for " + slice.id + ": " + decision.chosen +
        (lowConf ? " (low-confidence, reversible, auto-proceeded)" : ""));
    }
    const mergedPlan = { slice, patches };

    // ---- Build ----
    phase("Build");
    const build = await agent(
      "BUILD this slice. Implement to the plan, honoring the binding design rules in ARCHITECTURE.md. " +
      SACRED_TEXT + "Plan and any accepted patches:\n" + JSON.stringify(mergedPlan) + "\nNever create scratch, " +
      "probe, throwaway, or lint-test files under source or build-output directories; they break the compile " +
      "and lint gates and can ship in the packaged artifact. If you must create a temporary file to verify a " +
      "rule, put it under .claude-working/ (gitignored) and remove it when done. Run the compile to confirm it " +
      "builds. " + buildBranchText(slice) +
      (slice.visualCheck ? "This is a UI slice bound to " + VISUAL_REF + ". After building, run '" +
      slice.visualCheck + "' to produce the harness screenshots, READ them (the Read tool renders images) side " +
      "by side with the reference screenshots, and iterate until the rendered output matches the design before " +
      "handing to review. " : "") +
      "Do NOT git add, commit, or push. No em dashes, en dashes, or emojis in code or docs.",
      { label: "build:" + slice.id, phase: "Build" });
    if (build == null) throw new HaltError("Build agent died for " + slice.id, { stage: "build", slice: slice.id });

    // ---- Loop-until-dry: review (4 lenses + optional visual + completeness) then fix, up to MAX_FIX_ROUNDS ----
    let round = 0;
    while (true) {
      round += 1;
      phase("Review");
      const reviews = await parallel([
        () => agent("Adversarial REVIEW, lens correctness-build-health. REFUTE the slice's correctness and " +
          "build health: compile and lint errors, logic bugs, missing error handling, broken edge cases. Read " +
          "the diff and files. Slice " + slice.id + ". critical = build-breaking or incorrect behavior. Return " +
          "lens 'correctness-build-health', summary (one line), and findings. Round " +
          round + ".", { schema: critiqueSchema, label: "rev-correctness:" + slice.id, phase: "Review" }),
        () => agent("Adversarial REVIEW, lens integration-fit. REFUTE that this slice integrates with the " +
          "built slices [" + builtSlices.join(", ") + "] and ARCHITECTURE.md: contract drift, id collisions, " +
          "store- or schema-shape mismatch, naming or registration clashes. Read the files. Slice " + slice.id +
          ". Return lens 'integration-fit', summary (one line), and findings. Round " + round + ".",
          { schema: critiqueSchema, label: "rev-integration:" + slice.id, phase: "Review" }),
        () => agent("Adversarial REVIEW, lens sacred-constraint-data-integrity (the SACRED constraints). " +
          "REFUTE that the slice is safe: " +
          (SACRED.length ? "ANY path that could violate one of these sacred project constraints: " +
          SACRED.join("; ") + "; and ANY path that could lose or corrupt persisted data. " :
          "ANY path that could lose or corrupt persisted data or application state. ") +
          "Mark such findings category sacred-constraint or data-loss and severity critical. Read the files. " +
          "Slice " + slice.id + ". Return lens 'sacred-constraint-data-integrity', summary (one line), and " +
          "findings. Round " + round + ".",
          { schema: critiqueSchema, label: "rev-sacred:" + slice.id, phase: "Review" }),
        () => agent("Adversarial REVIEW, lens untrusted-input-security. REFUTE the safety of every boundary " +
          "this slice touches where untrusted data enters the system: externally derived strings rendered " +
          "into any UI, markup, or template (verify escaping and any content-security policy), message or " +
          "event handlers that accept structured payloads (EVERY field validated: ids via an allowlist gate, " +
          "constrained formats via strict patterns, map keys before any map write or path join), imported or " +
          "synced JSON (prototype pollution, unvalidated map keys), and any filesystem path derived from " +
          "untrusted input (traversal past the write guards). " +
          "Verify the WHOLE CLASS at each boundary, not single instances: check ALL map keys, ALL id sinks, " +
          "ALL constrained-format fields, ALL render interpolations, and say so in the finding detail. " +
          "category security; an exploitable path is critical, a likely-but-unproven one major. Read the diff " +
          "and files. Slice " + slice.id + ". Return lens 'untrusted-input-security', summary (one line), and " +
          "findings. Round " + round + ".",
          { schema: critiqueSchema, label: "rev-security:" + slice.id, phase: "Review" }),
        ...(slice.visualCheck ? [() => agent("Adversarial REVIEW, lens visual-fidelity. REFUTE that the " +
          "rendered output matches the binding design reference (" + VISUAL_REF + "). Run '" +
          slice.visualCheck + "' to produce fresh harness screenshots, then READ them (the Read tool renders " +
          "images) next to the reference screenshots and compare layout, spacing, colors, typography, and " +
          "interaction states this slice ships. A visible mismatch against a specified token, metric, or " +
          "layout is major; a broken or missing element is critical; do NOT flag the agreed deviations listed " +
          "in the design reference. category visual. Slice " + slice.id + ". Return lens 'visual-fidelity', " +
          "summary (one line), and findings. Round " + round + ".",
          { schema: critiqueSchema, label: "rev-visual:" + slice.id, phase: "Review" })] : []),
        () => agent("COMPLETENESS critic, lens completeness. What did the slice MISS versus its plan, its " +
          "GitHub issue, and the DoD: " + (slice.issue ? "run 'gh issue view " + slice.issue + "' and check " +
          "EVERY acceptance-criteria checkbox in the issue body against the actual diff; an unmet or " +
          "partially met criterion is a major finding named after its checkbox text. Also flag " : "flag ") +
          "an unimplemented plan item, an untested pure-logic unit, a missing edge case, a doc not " +
          "updated. List gaps as findings. Return lens 'completeness', summary (one line), and findings. " +
          "Slice " + slice.id + ". Round " + round + ".",
          { schema: critiqueSchema, label: "rev-completeness:" + slice.id, phase: "Review" })
      ]);
      const findings = aggregateFindings(reviews);
      const actionable = findings.filter(f => f.severity === "critical" || f.severity === "major");
      if (actionable.length === 0) { log("Slice " + slice.id + " review came back dry after round " + round + "."); break; }
      if (round > MAX_FIX_ROUNDS) {
        const safety = actionable.filter(f => f.category === "sacred-constraint" || f.category === "data-loss");
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
        "findings. CLASS-SWEEP RULE (non-negotiable): for every " +
        "finding, fix the NAMED instance AND sweep its entire sibling class, meaning the same flaw pattern at " +
        "every equivalent boundary (all map keys if one map key is flagged, all id sinks if one id is flagged, " +
        "all constrained-format fields if one is flagged, all render sites if one interpolation is flagged); a " +
        "finding is not resolved while any sibling still carries the flaw, and the re-review will check the " +
        "class. Then re-check by rebuilding AND running the slice tests (" + (slice.testCommand || DEFAULT_TEST) +
        ")." + (slice.visualCheck ? " If any finding was visual, re-run '" + slice.visualCheck + "' and READ " +
        "the screenshots to confirm the fix before reporting." : "") +
        " Report summary (one line), buildPasses, testsPass, and any remainingFindings. Findings:\n" + JSON.stringify(actionable) +
        "\nKeep any scratch or probe files under .claude-working/ (gitignored), never under source or " +
        "build-output directories, and remove them before reporting. Do NOT commit or push." + fixBranchText(slice),
        { schema: fixResultSchema, label: "fix:" + slice.id + ":r" + round, phase: "Fix" });
      if (fix == null) throw new HaltError("Fix agent died for " + slice.id, { stage: "fix", slice: slice.id });
      // loop re-reviews; the next round is the independent re-verification.
    }

    // ---- Independent test gate ----
    phase("Test");
    const test = await agent(
      "TEST GATE. Run exactly '" + (slice.testCommand || DEFAULT_TEST) + "' and separately the install/package " +
      "check '" + (slice.installCheck || DEFAULT_INSTALL) + "'. Report " +
      "passed (test exit 0), installable (install check exit 0), exitCode, command: the exact test command " +
      "run, and output: the tail of its output. Do not fix or commit.",
      { schema: testResultSchema, label: "test:" + slice.id, phase: "Test" });
    if (test == null || test.passed !== true || test.installable !== true || test.exitCode !== 0) {
      await persistState(slices, i, "test", { test });
      throw new HaltError("Tests or install check failed for " + slice.id, { stage: "test", slice: slice.id, test });
    }

    // ---- Commit and push (landed on main via a merge-commit PR) ----
    phase("Commit and Push");
    const commit = await agent(
      commitPrompt(slice, mergedPlan, test),
      { schema: commitResultSchema, label: "commit:" + slice.id, phase: "Commit and Push" });
    if (landingFailed(commit)) {
      await persistState(slices, i, "commit", { commit });
      throw new HaltError(commitFailPrefix + slice.id, { stage: "commit", slice: slice.id, commit });
    }
    builtSlices.push(slice.id);
    log("Slice " + slice.id + landedLogText + commit.sha);
  }

  // ---- Release and handoff (skipped on non-final parts of a multi-part sprint via runHandoff:false) ----
  let handoff = null;
  if (RUN_HANDOFF) {
    phase("Release and Handoff");
    handoff = await agent(
      "RELEASE AND HANDOFF. 1) Ensure README and CHANGELOG reflect the finished work; README must describe " +
      "LANDED work only (slices whose commits are on " + LANDING_REF + "), never planned or future work. 2) " +
      (PACKAGE_CMD
        ? "Package the distributable artifact by running '" + PACKAGE_CMD + "' and report its path as artifactPath. "
        : "No package command is configured for this run; report packaged true and artifactPath '(none)'. ") +
      "3) Write TESTING.md at the repo root: how to install or run the built work" +
      (PACKAGE_CMD ? " (including installing the packaged artifact)" : "") + ", and the consolidated " +
      "manual smoke checklist, since UI smoke needs a human. Include smoke steps ONLY for slices whose exact " +
      TRAILER_PREFIX + "-Slice trailer is on " + LANDING_REF + " (verify with git log " + LANDING_REF + "), NEVER for every " +
      "slice in " + PLAN_DOC + " (the plan contains future parts' slices that have not landed). " +
      handoffStep4Text(),
      { schema: handoffSchema, label: "handoff", phase: "Release and Handoff" });
    // noop true = a re-invoked, already complete run: nothing to commit and nothing repackaged, so ONLY the
    // null-check applies; all other booleans are ignored in that case.
    if (handoffFailed(handoff)) {
      await persistState(slices, slices.length - 1, "handoff", { handoff });
      throw new HaltError("Release and handoff failed", { stage: "handoff", handoff });
    }
  } else {
    log("Handoff is disabled for this part (runHandoff false); skipping Release and Handoff.");
  }

  phase("Run Summary");
  log("Done. " + slices.length + " slices on " + LANDED_BRANCH + ". Decisions: " + decisions.length + "." +
    (handoff
      ? " Artifact: " + handoff.artifactPath + ". Manual smoke checklist is in TESTING.md."
      : " Handoff skipped (runHandoff false)."));
  return { ok: true, built: builtSlices, decisions, artifactPath: handoff ? handoff.artifactPath : null };
} catch (e) {
  const ctx = (e && e.context) ? e.context : { stage: "unknown" };
  log("HALT: " + (e && e.message ? e.message : String(e)) + " | stage=" + (ctx.stage || "unknown") +
    (ctx.slice ? (" slice=" + ctx.slice) : "") + ". Working tree left for inspection; re-invoke to resume.");
  throw e;
}
