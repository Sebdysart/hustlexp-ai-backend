# Release-authority incident readback — 2026-08-28

Status: `DRAFT_REVIEW_INPUT / SOURCE_DATED_PUBLIC_READBACK / NOT_RELEASE_AUTHORITY`

Observation window: `2026-08-28T18:43:44Z` through `2026-08-28T18:51:37Z`

Production effects authorized or performed by this readback: `NONE`

This record preserves a read-only public GitHub and production-health observation. It does not prove authenticated administrator state, bypass-actor identity, audit-log causation, approval, signature authority, deployment safety, or production provenance. Re-read every mutable fact before acting.

## Critical observations

1. Public `main` was `d42975be9691c6dbe99f7580fac1b0d8258a3f7a`, seven commits ahead of the previously recorded `73c44eee22fa79c2957583217e69aa972291776f` and zero behind it.
2. The seven introduced commits were reported unsigned. The first-parent line includes merge commit `f94e98f72af1bf20b2568970f3f417a50742c448`, so the observed default-branch history is not linear.
3. The public payload for ruleset `20840525` reported `enforcement: active` and still listed required signatures, linear history, one approval, stale-review dismissal, last-push approval, resolved conversations, strict required checks, and the eight documented contexts. The unauthenticated payload omitted `bypass_actors` and `current_user_can_bypass`; it cannot prove zero bypass actors.
4. PR #281 was merged at unsigned head `3920ed32a10624ba6309944285362d5c1080177a` by its author. Its only review was a bot `COMMENTED` review; it had no `APPROVED` review. On that exact SHA, lint and tests failed and Build Validation was skipped.
5. Current `main` contains 3,248 `.local-tools` tree entries, including 1,576 tracked files. The invariant requiring bundled local tooling to be absent is not satisfied.
6. GitHub deployment `6142799813` bound `d42975be…` to environment `authentic-compassion / production`. Its latest public deployment status was `success` at `2026-08-28T14:22:28Z`, proving production Git auto-deployment remained attached for that commit.
7. The public production `/health` endpoint returned HTTP 200 and reported `paymentCreation.mode=frozen` with `acceptsNewCustomerMoney=false`. It simultaneously reported stale build revision `140ce19f4f77926249b1e7c0e5d2aac29bd4c9ef`, built `2026-07-23T04:37:52Z`, rather than deployed source `d42975be…`. The response supports the payment-freeze observation only; it cannot attest the running artifact or exact deployed SHA.

## Recovery simulation

A clean public clone at current `main` ran the required non-committing simulation:

```text
git revert --no-commit -m 1 c2754ad37ffddf2ea75d22ba48517a9c3c7bf3a4
```

The operation produced 36 unresolved modify/delete conflicts across configuration, API composition, Work Order/payment execution, media/privacy, tests, migration verification, and Supabase-cutover documentation. The simulation was aborted with `git revert --abort`; no commit, push, merge, deployment, or remote mutation occurred.

This triggers the recovery plan's reconstruction branch: do not resolve the conflicted revert by guessing. Build a new forward-repair candidate from reviewed source, carrying only independently reviewed changes and preserving existing history as evidence.

PR #278 head `90b92c917b7f88e41780b07af506cba96c0ec60f` remains a useful exact input: GitHub reports a valid signature; its tree contains zero `.local-tools` entries and retains the separately merged documentation; and all eight required contexts succeeded on that SHA. It has zero submitted reviews, is based on stale `73c44eee…`, and is not merge authority for current `main`.

## Required containment before another merge

1. Disable production Railway Git auto-deployment and capture an authenticated, secret-redacted readback proving zero production Git triggers.
2. Revoke the credential previously exposed in chat. Replace it with a short-lived, least-privilege secret reference; do not paste another token.
3. Obtain an authenticated ruleset readback for `20840525`, including `bypass_actors`, `current_user_can_bypass`, and relevant audit-log evidence. Identify and remove the mechanism that allowed unsigned, unreviewed, red commits to reach `main`.
4. Preserve PRs #274, #276, #277, #278, and #281 plus every named SHA and deployment as incident evidence.
5. Form one intentional signed forward-repair candidate whose exact tree excludes `.local-tools`, retains legitimate independently reviewed documentation, passes every required check with none skipped, and receives independent and last-push approval.
6. Keep production payment creation, hard assignment, real settlement/payout, database migration, and deployment changes frozen until their separate gates pass.

## Public readback endpoints

- Ruleset: `https://api.github.com/repos/Sebdysart/hustlexp-ai-backend/rulesets/20840525`
- Default branch: `https://api.github.com/repos/Sebdysart/hustlexp-ai-backend/branches/main`
- Comparison: `https://api.github.com/repos/Sebdysart/hustlexp-ai-backend/compare/73c44eee22fa79c2957583217e69aa972291776f...main`
- PR #281: `https://api.github.com/repos/Sebdysart/hustlexp-ai-backend/pulls/281`
- PR #281 reviews: `https://api.github.com/repos/Sebdysart/hustlexp-ai-backend/pulls/281/reviews`
- PR #281 checks: `https://api.github.com/repos/Sebdysart/hustlexp-ai-backend/commits/3920ed32a10624ba6309944285362d5c1080177a/check-runs`
- Current-main deployment: `https://api.github.com/repos/Sebdysart/hustlexp-ai-backend/deployments?sha=d42975be9691c6dbe99f7580fac1b0d8258a3f7a`
- Deployment statuses: `https://api.github.com/repos/Sebdysart/hustlexp-ai-backend/deployments/6142799813/statuses`
- Production health: `https://hustlexp-ai-backend-production.up.railway.app/health`
