# Prepared financial command integration checkpoint

Recorded 2026-09-06T20:49:37.821Z. Backend remains incomplete. This is local engineering evidence, not release certification.

The PostgreSQL preparation tests now create claimed actor-bound TaskDrafts through the existing ingress/contact/claim flow and use the real attester and API roles. The concurrency case checks six distinct PostgreSQL backend process IDs and releases six open API transactions together. It proves one new committed preparation and five exact replays. The shared fixture owns bounded connection pools and closes them before database/role cleanup.

The service now translates exactly HXUV1-FINPREP-13-IDEMPOTENCY_CONFLICT into its existing typed idempotency conflict. Unrelated database errors propagate unchanged, with no retry. A new unit regression failed before the mapping and passed afterward. The three different conflict inputs remain tested; no sealed SQL or authorization rules changed.

**All five PostgreSQL cases pass**: six-way concurrency, exact replay and three conflict identities, PREPARED/REQUESTED commit with adapter refusal before dispatch, database-owned time, approved-provider refusal and immutable mutation guards. The two complete unit files pass **24 tests**. Expanded TypeScript, final changed-file lint and whitespace checks pass.

The complete isolated readiness run finished at 2026-09-06T20:44:11.102Z: **11034 passed, 24 failed, 15 skipped, 0 todo across 697 files; FAIL**. Its frozen source snapshot is unchanged. All readiness/runtime/recovery and incident-guard repairs passed there. This full run excludes the later preparation changes; do not subtract the five focused passes from its archived failures.

There are **9 local source changes** relative to public 1da48ae. All **242 SQL files are byte-for-byte unchanged**. The original HEAD and index are preserved. No commit, push, deployment, real payment or hard assignment occurred.

Next source-confirmed runtime gap: startup still starts the legacy provider-event replay worker, whose default repository uses raw processing tables and an owner-only normalization function. The current sealed financial recovery path handles independently signed observations. Prove the mismatch under an actual restricted worker connection, then connect normal startup and health to the supported path while preserving historical migration/replay coverage.

Remaining scope includes estimate/history, provider-account and terminal financial flows, current Docs behavior, all thirteen journeys and process/restart/restore/clean-clone and independent release/staging proof.

[Exact source and validation manifest](backend-preparation-integration-review-manifest.json). [Full required result](backend-required-isolated-readiness-review.md).
