# Worker reversal adapter checkpoint

Recorded 2026-09-06T04:11:59.716Z. Backend and release certification remain incomplete.

The worker now derives an exact reversal request from a committed compensation winner, validates sealed preparation and worker provenance, commits PREPARED, then records REQUESTED/outbox through the existing journal. Both transaction boundaries validate current installed authority; the raw request receipt is checked before numeric/date mapping. Historical participant attribution and timestamp precision are retained.

Validation: 291 unit tests across nine complete files and 129 PostgreSQL/Redis tests in the complete restricted-role cohort pass with zero failures, skips or todos. Compilation, expanded test types and zero-warning source lint pass. Lost PREPARED and REQUESTED commit acknowledgements are injected after actual COMMIT; fresh adapters replay exact identities, real Redis delivers the work, and completed-job retry preserves one effect and one REVERSED lifecycle fact. Migrations are unchanged.

The installed release/authentication composition is synthetic in integration tests. This does not establish normal signed process boot or scheduled recovery. Exact terminal writers and scheduler integration remain; REQUESTED and REVERSED alone do not clear recovery holds. The earlier full required gate remains FAIL (27 failed, 33 skipped). Production effects NONE; customer money and hard assignment FROZEN.

[Exact manifest](backend-change-order-reversal-adapter-review-manifest.json) · [Incremental patch](backend-change-order-reversal-adapter-review.patch)
