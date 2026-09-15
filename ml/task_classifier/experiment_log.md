# Extended classifier tuning experiment log

## Evaluation policy

- The previously consumed `blind_holdout_300.json` is historical evidence only. It was not run or used for tuning in this investigation.
- The development corpus contains 380 newly authored cases across ten boundary/stress groups. Exact text overlap with the training corpus is zero.
- The retained model uses balanced `LinearSVC(C=1.0)` and a global ambiguity threshold of `0.50`.
- All metrics below are development metrics unless explicitly identified as cross-validation or historical evidence.

## Starting point

- Training rows: 293 service examples.
- Global threshold: 0.75.
- Existing checks: focused 40/40, holdout categories 200/200, validation categories 150/150, known regressions 4/4, parity 293/293.
- Historical consumed blind result: 98.61% emitted precision, 72.00% emission, 45 unnecessary abstentions, one false concrete on vague. This result is not a fresh score.

## Experiment 1: new boundary development corpus

- Hypothesis: the existing regressions underrepresent adjacent-category and abstention boundaries.
- Change: created 380 cases: 50 each for moving/delivery, handyman/assembly, handyman/plumbing, and handyman/electrical; 30 each for events/vague, pet/cleaning-home, home-services/handyman, short imperatives, multi-intent, and vague abstention.
- Result at the starting 0.75 configuration: 92.66% emitted precision, 68.16% emission, 19 incorrect emissions, and 76 unnecessary abstentions. Model-only precision was 97.73% with only 46.32% emission.
- Decision: retained the corpus. It exposed both coverage gaps and unsafe broad override behavior.

## Experiment 2: global threshold sweep

- Hypothesis: 0.75 is overly conservative after data and override improvements.
- Change: measured 0.45 through 0.80 for production resolution and the statistical model alone.
- Result: the initial system could not safely recover much coverage by threshold alone. After the retained data and override changes, production precision is 100% at every measured threshold; emission ranges from 77.89% at 0.45 to 67.63% at 0.80.
- Decision: retained 0.50. It emits 293/380 cases with no development mis-emissions and keeps a 0.05 buffer above the highest-coverage sweep point; 0.45 would recover only three additional cases.

## Experiment 3: SVM C grid

- Hypothesis: a different regularization strength may improve low-margin category separation.
- Change: compared balanced and unweighted LinearSVC at C values 0.25, 0.5, 1, 2, and 4 over the full threshold sweep.
- Result: larger C values increase raw emission modestly but also increase vague emissions or errors. On the final corpus, balanced C=1 at 0.45 produced 99.65% model-only precision and 74.21% emission; C=2 produced 98.63% and 76.84%; C=4 produced 98.01% and 79.21% with two wrong concrete emissions and four false vague emissions.
- Decision: retained balanced C=1.

## Experiment 4: class weighting

- Hypothesis: class balancing may be unnecessary once the corpus is expanded.
- Change: compared `class_weight="balanced"` with no class weighting for every C value.
- Result: unweighted variants sometimes gained about one point of raw emission, but introduced more wrong or vague emissions at comparable thresholds and did not improve stability.
- Decision: retained balanced weighting.

## Experiment 5: five-fold cross-validation

- Hypothesis: full-fit development metrics may hide small-data instability.
- Change: added per-fold emitted precision, coverage, accepted recall, variance, category recall, confusion pairs, and a CV threshold sweep.
- Result for balanced C=1 at 0.50: mean emitted precision 93.16% (SD 4.43), coverage 69.00% (SD 3.83), and accepted recall 64.40% (SD 5.91). Fold precision ranged from 84.62% to 96.67%. The strongest recurring confusions were handyman/assembly, home-services/plumbing, delivery/moving, and handyman/plumbing.
- Decision: retained the reporting and treated the variance as a reason to require a new blind set before further threshold reduction.

## Experiment 6: first diverse training expansion

- Hypothesis: broader linguistic coverage can replace unsafe override emissions and lift low-margin correct classifications.
- Change: added 86 varied service examples covering terse commands, indirect requests, object-first and symptom-first wording, resource clauses, and adjacent-category boundaries.
- Result: the raw model reached 99.25% precision and 70.26% emission at 0.50. Full overrides still reduced precision, confirming that data alone did not make the original override policy safe.
- Decision: retained the data; continued with override-policy experiments.

## Experiment 7: remove broad overrides

- Hypothesis: improved training makes the broad painting, plumbing, electrical, moving, and yard overrides redundant.
- Change: removed the five broadest override paths and measured at 0.75 and 0.50.
- Result: development precision improved to 97.70% at 0.75, and the 0.50 simulation reached 99.31% precision with 75.79% emission. The real configuration failed five focused regressions, 17 holdout categories, and eight validation categories at 0.75; at 0.50 it still failed one focused case, five holdout categories, and two validation categories.
- Decision: reverted full removal.

## Experiment 8: agreement-gated overrides

- Hypothesis: overrides can act as confidence evidence without replacing a conflicting model prediction.
- Change: required most overrides to agree with raw top-1 and exceed a 0.30 raw margin, with a small low-margin allowlist. Category changes were limited to narrow delivery/resource, pet-cleaning, screen-door, patch-and-paint, and ceiling-fan boundaries.
- Result: eliminated override-caused development errors while retaining useful low-margin rescues. Removing all overrides at the final threshold reduces emission from 77.11% to 72.37% and increases unnecessary abstentions from 42 to 60.
- Decision: retained.

## Experiment 9: multi-intent and first-operation data

- Hypothesis: primary intent errors in multi-clause requests come from missing order and clause-diversity examples.
- Change: added 25 examples emphasizing first requested operation and mixed category clauses.
- Result: restored focused, holdout, validation-category, and known-regression behavior under agreement-gated overrides.
- Decision: retained.

## Experiment 10: vague-request guard

- Hypothesis: generic person/help/time wording should abstain before threshold and override resolution.
- Change: added a semantic guard for generic assistance requests that contain no concrete task signal, and expanded concrete signals only with explicit task verbs, objects, and event nouns.
- Result: all 45 development vague cases abstain, with zero false concrete emissions. Clear phrases such as plumbing help, electrical help, and event requests remain eligible.
- Decision: retained.

## Experiment 11: category-specific thresholds

- Hypothesis: low-margin categories may safely use lower thresholds than the global value.
- Change: measured each raw top-1 category at 0.45 and 0.55-0.70 while holding all others at 0.50.
- Result: lowering electrical, handyman, or moving to 0.45 recovered one case each with no development error. Every other category gained nothing. The maximum individual gain was 0.26 percentage points of total emission.
- Decision: not retained; the gain does not justify per-category configuration yet.

## Experiment 12: override-removal after training expansion

- Hypothesis: a second data pass may allow individual overrides to be deleted safely.
- Change: simulated removal of every observed override reason and a combined high-risk set.
- Result: several broad matches were already redundant because the agreement/margin gate blocked unsafe emissions. Removing all overrides costs 18 correct emissions. The most useful rescues came from plumbing, leading household movement, pickup/delivery, cleaning, home-services, automotive components, ceiling-fan service, and patch-and-paint. Removing the combined high-risk set at 0.50 retained 100% precision but reduced emission to 75.53%.
- Decision: retained the gated policy. No new large override table was introduced.

## Experiment 13: local-context boundary data

- Hypothesis: handyman work near plumbing/electrical objects and electrical-first multi-intent requests need representation rather than new regex exceptions.
- Change: added nine examples for wall/plaster repair near fixtures and electrical work followed by paint touch-up.
- Result: removed the remaining 0.55 development error and prevented an electrical-first multi-intent request from flipping to painting. The final development sweep has zero incorrect emissions at all measured thresholds.
- Decision: retained.

## Final development result

- Training rows: 413 service examples, up by 120.
- Threshold: 0.50.
- Correct emitted: 293.
- Incorrect emitted: 0.
- Correct vague abstentions: 45.
- Unnecessary abstentions: 42 of 335 concrete cases (12.54%).
- Emitted precision: 100.00%.
- Emission rate: 77.11%.
- Concrete accepted accuracy: 87.46%.
- This is development evidence, not a blind generalization estimate.

## Repair pass after consumed blind holdout v2

`blind_holdout_v2_1000.json` was consumed once as a blind set, then explicitly promoted to development/regression data. Its original one-shot result remains historical evidence. All metrics below are development metrics.

### Experiment 14: reproduced consumed-set baseline

- Hypothesis: the repository still matches the frozen one-shot configuration.
- Result on the original oracle: 642 correct emissions, 81 wrong concrete emissions, 191 unnecessary abstentions, 81 correct vague abstentions, and five false concrete vague emissions (88.19% emitted precision).
- Decision: baseline confirmed; no discrepancy blocked tuning.

### Experiment 15: wall-mount taxonomy normalization

- Hypothesis: wall-mounted mirrors and already-assembled bookshelves conflict with the established assembly questionnaire and regression policy.
- Change: created a separate curated development copy; all 14 mirror-mount variants and six already-assembled-bookshelf wall-mount variants are labeled `assembly`. The original consumed file remains unchanged.
- Result before classifier changes: 653 correct, 70 wrong, 191 unnecessary abstentions, and five false-vague emissions.
- Decision: retained as development-oracle cleanup.

### Experiment 16: remove the broad bring override

- Hypothesis: provider-resource wording is being mistaken for delivery.
- Simulation: disabling `explicit_bring_task_object` reduced wrong emissions from 70 to 60 and raised precision from 89.70% to 91.02%, at the cost of four additional abstentions.
- Decision: broad behavior rejected.

### Experiment 17: transport-qualified bring semantics

- Change: `bring` requires source/destination or pickup/transport evidence and excludes provider tools, equipment, materials, supplies, paint, and vehicles.
- Result: 659 correct, 61 wrong, and 194 unnecessary abstentions. All ten provider-resource delivery errors disappeared; one overlapping case then exposed the pet-cleaning rule.
- Decision: retained. Strong pickup/delivery language remains authoritative; plain `bring` is not sufficient.

### Experiment 18: remove pet-related cleaning authority

- Hypothesis: the rule erases primary pet-care actions.
- Simulation: disabling it reduced wrong emissions from 70 to 60 with no coverage loss.
- Decision: broad behavior rejected.

### Experiment 19: pet-care primary-action semantics

- Change: feeding, walking, watching, sitting, checking on, refilling food/water, letting out, medication, and caring for an animal suppress the pet-cleaning override. Pure pet-hair/stain/odor cleaning remains cleaning.
- Result with the repaired bring rule: 670 correct, 50 wrong, 194 unnecessary abstentions, 92.41% precision.
- Decision: retained.

### Experiment 20: general exclusion/negation guard

- Hypothesis: category terms explicitly described as fine, working, ignored, already repaired, not needed, or excluded should not drive classification.
- Change: added reusable category exclusions for plumbing, electrical, painting, events, auto, and assembly. Overrides skip excluded categories; an excluded raw top result abstains unless a separately affirmed safe task rule applies.
- Result: wrong emissions fell from 50 to 13 without losing a correct emission; abstentions rose from 194 to 231. Precision reached 97.38%.
- Decision: retained for safety.

### Experiment 21: event-service eligibility

- Hypothesis: a private dinner or personal celebration lacks service intent.
- Change: dinner/celebration language now needs guests, attendees, setup, cleanup, service, staffing, decoration, catering, buffet, or venue evidence. Parties, weddings, receptions, ceremonies, galas, banquets, and corporate events remain event signals.
- Result: all five false concrete vague emissions became correct abstentions; no concrete event was lost in this experiment.
- Decision: retained.

### Experiment 22: targeted plumbing, electrical, and automotive overrides

- Change: replaced object-anywhere rules with direct action/target and target/fault grammars. Transported car parts no longer become auto work; cabinets near sinks and damage near toilets no longer become plumbing.
- Result: 677 correct, seven wrong, 230 unnecessary abstentions, zero false-vague emissions, 98.98% precision.
- Decision: retained.

### Experiment 23: home-damage assessment evidence

- Hypothesis: inspect/assess/check language around soft, swollen, damp, cracked, or water-damaged building surfaces is reliable home-services evidence.
- Change: added an agreement-only low-margin rule; it cannot replace another model category.
- Result: recovered 13 correct emissions, reaching 690 correct and 217 unnecessary abstentions without adding an error.
- Decision: retained.

### Experiment 24: explicit primary task operations

- Change: expanded the existing authoritative patch-and-paint rule to cover holes/dents followed by repainting, and made direct pet-care actions authoritative when cleanup is incidental.
- Result: 702 correct, five wrong, 207 unnecessary abstentions, zero vague errors.
- Decision: retained.

### Experiment 25: diverse training expansion

- Hypothesis: the remaining errors and abstentions include genuine representation gaps.
- Change: added 64 varied examples: assembly 8, handyman 10, home-services 12, events 6, painting 4, pet-care 8, cleaning 6, delivery 4, and auto 6.
- Result after retraining: 725 correct, eight wrong, 181 unnecessary abstentions on the then-current curated oracle. Python/Node parity passed 477/477.
- Decision: retained.

### Experiment 26: negated assembly and complete wall-mount policy

- Change: `do not assemble` and equivalent wording exclude assembly, affirmative carry/move semantics can replace that excluded top category, and all semantically identical wall-mount oracles were normalized.
- Result: 735 correct, zero wrong, 179 unnecessary abstentions, zero false-vague emissions.
- Decision: retained.

### Experiment 27: post-repair threshold sweep

- Thresholds 0.30 through 0.80 were measured after semantic repair and retraining.
- At the final policy: 0.45 recovered three cases with no development error; 0.40 introduced two wrong emissions; 0.30 introduced four wrong emissions and one vague false positive.
- Decision: retained 0.50. The three-case gain at 0.45 did not justify removing the safety buffer.

### Experiment 28: excluded-top affirmative fallback

- Hypothesis: an explicitly excluded raw category can safely yield to a separately asserted cleaning, handyman surface-repair, home-damage, or household-moving action.
- Result: 765 correct, zero wrong, 149 unnecessary abstentions.
- Decision: retained. The fallback is unavailable unless the raw top category was explicitly excluded.

### Experiment 29: authoritative non-negated assembly actions

- Result: recovered nine correct cases with no error, reaching 774 correct and 140 unnecessary abstentions.
- Decision: retained behind assembly-negation handling.

### Experiment 30: handyman installed-hardware taxonomy

- Policy: mounting TVs/mirrors/shelves/cabinets is assembly; installing towel bars/rails and robe/coat hooks, plus repairing installed cabinets/bookshelves/brackets, is handyman.
- Result: recovered 17 correct cases with no error, reaching 791 correct and 123 unnecessary abstentions.
- Decision: retained.

### Experiment 31: core-regression grammar repair

- Change: direct repainting and targeted electrical fault/operation grammar were made eligible; functioning-state exclusions were tightened so `stopped working` is not mistaken for `works`; guest-count dinner language is event-eligible.
- Result: 794 correct, zero wrong, 120 unnecessary abstentions, and all 86 vague cases abstained.
- Decision: retained.

### Experiment 32: override authority reduction

- Simulation/change: demoted broad painting, pure pet-cleaning, and transport-qualified bring rules, and tested demoting direct electrical work.
- Result: painting and pure pet-cleaning authority were unnecessary. Demoting direct electrical work lost three clear outlet cases, so that part was reverted. Transport-qualified bring authority was restored after validation150 exposed two clear destination-bearing delivery regressions.
- Decision: retained only the portions required by semantic regressions; provider-resource `bring` remains blocked.

### Development-oracle normalization: original 300-case set

The original 300-case development file still labeled a wall-mounted shelf, floating-shelf installation, and a mounted coat rack as `handyman`. Current questionnaire ownership, focused regressions, holdout200, validation150, and training data all assign wall-mounted shelves/racks to `assembly`. Those three development labels were normalized to `assembly`; this is taxonomy cleanup rather than classifier tuning.

## Final repair-pass development result

- Training rows: 477 service examples.
- SVM: balanced `LinearSVC(C=1.0)`.
- Global threshold: 0.50.
- Correct emitted: 794 of 914 concrete cases.
- Incorrect emitted: 0.
- Unnecessary abstentions: 120 (13.13% of concrete cases).
- Correct vague abstentions: 86/86.
- False concrete on vague: 0.
- Emitted precision: 100.00%.
- Concrete accuracy and coverage: 86.87%.
- Overall emission rate: 79.40%.
- These are tuned development results and must not be presented as fresh generalization evidence.

### Experiment 33: exclusion-scope and unseen semantic regression check

- Hypothesis: pronoun-only exclusion phrases and untested action synonyms could hide valid task intent or leave settled taxonomy boundaries uncovered.
- Change: required a category target to be present before `without touching it/that` can exclude that category; added `hang` to the wall-mount action family and allowed an explicitly excluded electrical reference to coexist with an assembly wall-mount request. Event-service eligibility now accepts `supper` and `meal` only when guest/staff/service evidence is also present.
- Result: focused classifier regressions pass 58/58. The final 1,000-case development metrics remain 794 correct emissions, zero wrong emissions, 120 unnecessary abstentions, 86 correct vague abstentions, and zero vague false positives.
- Decision: retained. These changes tighten scope or extend already-settled action semantics without lowering the global threshold.

### Experiment 34: final 477-row SVM and cross-validation refresh

- Hypothesis: the retained `C=1.0` choice should be rechecked after the 64-example repair-pass expansion.
- Change: reran the balanced/unbalanced `C={0.25,0.5,1,2,4}` development grid and five-fold stratified cross-validation on all 477 service rows.
- Result: at threshold 0.50, balanced C=1 had 99.63% model-only development precision and 71.58% emission. C=2 and C=4 increased emission but introduced more concrete/vague errors. Five-fold balanced C=1 averaged 93.61% precision, 71.48% coverage, and 66.87% accepted recall; fold precision ranged from 89.71% to 96.72%.
- Decision: retained balanced C=1.0. The higher-C coverage gain does not justify its reduced safety, and the rule-gated production path is evaluated separately.
