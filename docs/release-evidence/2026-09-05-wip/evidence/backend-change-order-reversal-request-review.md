# Worker reversal SQL boundary checkpoint

The restricted worker can now prepare the exact compensating REVERSAL from a committed compensation origin, then submit it through the existing durable journal/outbox. Preparation no longer depends on a banned participant obtaining a fresh assertion. Historical participant attribution remains separate from the worker's immutable provenance.

The origin's recovery lease can expire after its compensation winner commits. New preparation requires current target/release authority and an ancestor origin in the same database/environment. A committed preparation retains its original target and release; it cannot retarget. Missing legacy origin is rejected rather than adopted.

New requests and first execution recheck the current Work Order, frozen task, base scope, absence of amendment/recovery terminal/later financial event, and admitted successful ADJUST. Worker requests take nonblocking journal locks to avoid reversed lock ordering. The command owner reaches private provenance through a narrow finance-owned function. A deferred preparation guard prevents participant-origin preparation from consuming a worker-origin winner, including after the participant is restored.

The exact checkpoint passes 246 unit tests and 273 PostgreSQL/Redis tests in four complete financial/readiness cohorts, with zero failures, skips or todos. Compilation, expanded test types and zero-warning source lint pass. Two fresh databases reproduce the prior catalog and the new 157-function/348-explicit-trigger catalog. Existing migration bytes, frozen predecessors and unrelated worktree files are preserved; the incremental patch is checked forward and backward.

The database result combines three unchanged passing cohorts (116+22+8 cases) with the complete127-case role cohort rerun after a final test fixture-order correction. The initial run had one failed test: the new fixtures ran before existing queued-request isolation. Application code remained unchanged; both receipts and an exact inverse-byte proof are retained.

Seven new PostgreSQL cases cover these boundaries. The existing target-rollover case also verifies successor preparation and retarget rejection; three new readiness cases detect damaged provenance foreign-key enforcement and timestamp defaults. Privileged task corruption is an explicit disposable-owner fault injection. Actual worker-origin execution uses restricted SQL ports and synthetic dispatch evidence; existing broader cohorts include Redis journeys.

The TypeScript request adapter, scheduled-worker integration, exact recovery terminal writers and remaining winner/no-effect races are still unfinished. This is a SQL checkpoint, not backend or release completion. The latest complete required gate on earlier source remains 10,571 passed, 27 failed and 33 skipped across 684 files. Production effects NONE; customer money and hard assignment FROZEN. Signing, independent human review and isolated staging remain separate gates.

Recorded 2026-09-06T03:30:09.429Z. [Exact manifest](backend-change-order-reversal-request-review-manifest.json). [Incremental patch](backend-change-order-reversal-request-review.patch).
