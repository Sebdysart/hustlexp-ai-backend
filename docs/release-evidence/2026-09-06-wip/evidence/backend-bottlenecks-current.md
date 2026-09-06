# Backend progress and bottlenecks — September 6, 2026

Backend incomplete; substantial product and integration work remains before release certification. The 60-row current-Docs matrix is the completion baseline. Test pass rate is not a completion percentage.

The complete required suite finished at 2026-09-06T08:55:49.969Z: **11,012 passed, 27 failed, 33 skipped, 0 todo across 696 files; gate FAIL**. All 1806 source inventory entries remained unchanged. [Archived full result](backend-required-after-validation-integration-failures.json).

The separate quote-recovery Build Validation failure is now fixed: the standard PostgreSQL fresh/upgrade/precision verifier passes. Three migration unit failures also pass after reviewed expectation/digest updates; no SQL was changed. Both public financial event routes now submit durable requests and their real crash/replay journey passes. The new complete required run is terminal; its counts are recorded above.

| Priority | Observed failure group | Count in required suite | Next implementation or diagnostic action |
| --- | --- | --- | --- |
| 1 | Estimate materialization and downstream journeys | 13 failed | Repair actual history/resume and financial caller composition, then prove the original end-to-end assertions. |
| 1 | Prepared commands, lifecycle, provider observations and financial-security expiry | 10 failed | Connect callers and fixtures to genuine actor authority and durable financial commands; retain denial tests. |
| 2 | Bootstrap/readiness discovery | 2 failed; 18 skipped after setup failure | Diagnose attestation_unavailable before expected schema evidence; preserve restricted-runtime checks. |
| 2 | Contaminated upgrade and legacy command-port catalog | 1 failed; 15 skipped after setup failure | Reproduce catalog differences and migration ordering before changing any expected catalog. |
| 2 | Migration contracts and artifact digest | 3 failures in prior full run; focused files now pass | All three affected files pass in the full integrated run. Exact SQL bytes were preserved. |
| 2 | Separate quote-recovery Build Validation | Now PASS outside required-suite totals | Scoped verifier database and exact timestamp recovery are proven; application runtime guards remain. |
| 3 | Current Docs product behavior | Not measured by test count | Complete nine routing outcomes, seven WorkLink classes, assessment/appointment/diagnostic distinctions and commercial controls. |
| 4 | Complete product and release evidence | Still incomplete | Prove all 13 journeys, normal process startup/restart, clean clone and restore; then independent signed review and isolated staging. |

The existing scheduled change-order worker now uses the restricted commands. Its three real PostgreSQL/Redis journeys prove amendment, reversal and no-effect terminal recording after reconstruction and duplicate delivery. Remaining synchronous capture, settlement, payout, refund and work-order compensation callers still need integration.

Workflow: work by the failure groups above, run the smallest affected tests after each fix, then run the full required suite once per integrated checkpoint. Keep the existing architecture. This completed full run took 28.5 minutes in Vitest; the role/authority file took 18.1 minutes. Avoid repeating that entire file for unrelated changes; improve isolation before any database parallelization. Keep a single current matrix and failure register, and publish reviewable WIP checkpoints with test failures disclosed.

Public branch readback at this checkpoint confirmed commit 5a252f8b7e2c0d9252a65dacabe8d5fd1174ec3b. The 20 current source changes relative to that public parent remain local. Public WIP is not release certification.

No additional user input is needed for the local fixes. Later dependent gates require approved economics and service capacity, applicable legal/payment decisions, repository/production containment evidence, signing identities and independent human review, and isolated staging resources. Production effects NONE; customer money and hard assignment FROZEN.

The current full run also exposes the incident-guard test’s stale expectation that the public router calls synchronous executeFinancialEvent. A read-only bootstrap reproduction finds no current target authority in the legacy fixture; required role configuration is also missing. Preserve the authority gates and rebuild the affected fixtures with a complete isolated target.
