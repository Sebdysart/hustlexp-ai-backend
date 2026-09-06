# Change-order terminal checkpoint

Recorded 2026-09-06T05:24:38.841Z. Backend and release certification remain incomplete.

The restricted worker can now record exact materialized, compensated and no-effect terminal facts through three sealed commands and a typed adapter. Original lease, witness, historical participant and financial evidence remain immutable. Retries recover the original terminal row after a real committed response is lost, including after lease expiry. Fresh ADJUST requests serialize against cancellation; stale transaction snapshots, wrong evidence, authority drift and conflicting terminal branches fail closed.

Validation: 341 unit tests across nine complete files (318 plus 23) and 164 PostgreSQL/Redis tests across two complete role/catalog/readiness cohorts pass with zero failures, skips or todos. Compilation, expanded types and zero-warning source lint pass. Two fresh catalog captures verify 161 functions and 348 explicit triggers and reproduce the previous catalog transactionally. The prior migration prefix is byte-for-byte preserved.

Scheduled recovery is still incomplete: worker ADJUST preparation/request recovery and amendment materialization are required before wiring the existing poller to the sealed components. Installed release/authentication composition remains synthetic in integration tests. Normal signed process boot, full required regression, current-Docs product gaps and release certification remain unproven. The earlier full required gate remains FAIL (27 failures, 33 skips). Production effects NONE; customer money and hard assignment FROZEN.

[Exact manifest](backend-change-order-terminal-review-manifest.json) · [Incremental patch](backend-change-order-terminal-review.patch)
