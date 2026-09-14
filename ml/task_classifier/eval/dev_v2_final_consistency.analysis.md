# Classifier evaluation post-run analysis

This report was generated from a saved evaluation result. It does not invoke the classifier.

## Global metrics

| Metric | Value |
| --- | --- |
| Total | 1000 |
| Concrete | 914 |
| Vague | 86 |
| Correct emitted | 794 |
| Incorrect emitted | 0 |
| Unnecessary abstentions | 120 |
| Correct abstentions | 86 |
| False concrete on vague | 0 |
| Emitted precision | 100.00% |
| Concrete accuracy | 86.87% |
| Concrete coverage | 86.87% |
| Unnecessary-abstention rate | 13.13% |
| False-vague rate | 0.00% |

## Per-category results

| Category | Total | Correct | Wrong | Abstained | Accuracy | Coverage | Precision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| assembly | 84 | 80 | 0 | 4 | 95.24% | 95.24% | 100.00% |
| auto | 59 | 44 | 0 | 15 | 74.58% | 74.58% | 100.00% |
| cleaning | 91 | 62 | 0 | 29 | 68.13% | 68.13% | 100.00% |
| delivery | 74 | 73 | 0 | 1 | 98.65% | 98.65% | 100.00% |
| electrical | 72 | 72 | 0 | 0 | 100.00% | 100.00% | 100.00% |
| events | 57 | 46 | 0 | 11 | 80.70% | 80.70% | 100.00% |
| handyman | 84 | 70 | 0 | 14 | 83.33% | 83.33% | 100.00% |
| home_services | 59 | 50 | 0 | 9 | 84.75% | 84.75% | 100.00% |
| moving | 72 | 64 | 0 | 8 | 88.89% | 88.89% | 100.00% |
| painting | 74 | 70 | 0 | 4 | 94.59% | 94.59% | 100.00% |
| pet_care | 59 | 55 | 0 | 4 | 93.22% | 93.22% | 100.00% |
| plumbing | 70 | 61 | 0 | 9 | 87.14% | 87.14% | 100.00% |
| vague | 86 | 0 | 0 | 86 | n/a | n/a | n/a |
| yard | 59 | 47 | 0 | 12 | 79.66% | 79.66% | 100.00% |

## Per-group results

| Group | Total | Correct | Wrong | Unnecessary abstain | Precision | Coverage |
| --- | --- | --- | --- | --- | --- | --- |
| assembly_handyman | 12 | 12 | 0 | 0 | 100.00% | 100.00% |
| cleaning_home | 12 | 6 | 0 | 6 | 100.00% | 50.00% |
| coat_traps | 12 | 11 | 0 | 1 | 100.00% | 91.67% |
| core_assembly | 40 | 36 | 0 | 4 | 100.00% | 90.00% |
| core_auto | 40 | 25 | 0 | 15 | 100.00% | 62.50% |
| core_cleaning | 40 | 35 | 0 | 5 | 100.00% | 87.50% |
| core_delivery | 40 | 39 | 0 | 1 | 100.00% | 97.50% |
| core_electrical | 40 | 40 | 0 | 0 | 100.00% | 100.00% |
| core_events | 40 | 29 | 0 | 11 | 100.00% | 72.50% |
| core_handyman | 40 | 40 | 0 | 0 | 100.00% | 100.00% |
| core_home_services | 40 | 33 | 0 | 7 | 100.00% | 82.50% |
| core_moving | 40 | 33 | 0 | 7 | 100.00% | 82.50% |
| core_painting | 40 | 38 | 0 | 2 | 100.00% | 95.00% |
| core_pet_care | 40 | 36 | 0 | 4 | 100.00% | 90.00% |
| core_plumbing | 40 | 31 | 0 | 9 | 100.00% | 77.50% |
| core_yard | 40 | 31 | 0 | 9 | 100.00% | 77.50% |
| events_vague | 12 | 12 | 0 | 0 | 100.00% | 100.00% |
| fan_traps | 12 | 10 | 0 | 2 | 100.00% | 83.33% |
| handyman_electrical | 24 | 19 | 0 | 5 | 100.00% | 79.17% |
| handyman_painting | 12 | 12 | 0 | 0 | 100.00% | 100.00% |
| handyman_plumbing | 24 | 24 | 0 | 0 | 100.00% | 100.00% |
| moving_delivery | 24 | 23 | 0 | 1 | 100.00% | 95.83% |
| multi_intent | 100 | 84 | 0 | 16 | 100.00% | 84.00% |
| noisy_short | 80 | 80 | 0 | 0 | 100.00% | 100.00% |
| override_traps | 40 | 27 | 0 | 13 | 100.00% | 67.50% |
| pet_clean | 12 | 12 | 0 | 0 | 100.00% | 100.00% |
| pressure_traps | 12 | 12 | 0 | 0 | 100.00% | 100.00% |
| vague | 80 | 80 | 0 | 0 | n/a | n/a |
| yard_debris | 12 | 10 | 0 | 2 | 100.00% | 83.33% |

## Wrong-emission root causes

| Root cause | Count |
| --- | --- |

## All incorrect concrete emissions

| ID | Group | Raw input | Expected | Emitted | Top 1 / score | Top 2 / score | Margin | Source | Override | Root cause |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## False concrete classifications on vague cases

| ID | Raw input | Emitted | Margin | Source | Override |
| --- | --- | --- | --- | --- | --- |

## Abstention distribution

### By expected category

| Category | Count |
| --- | --- |
| cleaning | 29 |
| auto | 15 |
| handyman | 14 |
| yard | 12 |
| events | 11 |
| home_services | 9 |
| plumbing | 9 |
| moving | 8 |
| assembly | 4 |
| pet_care | 4 |
| painting | 4 |
| delivery | 1 |

### By evaluation group

| Group | Count |
| --- | --- |
| multi_intent | 16 |
| core_auto | 15 |
| override_traps | 13 |
| core_events | 11 |
| core_yard | 9 |
| core_plumbing | 9 |
| core_moving | 7 |
| core_home_services | 7 |
| cleaning_home | 6 |
| core_cleaning | 5 |
| handyman_electrical | 5 |
| core_assembly | 4 |
| core_pet_care | 4 |
| core_painting | 2 |
| fan_traps | 2 |
| yard_debris | 2 |
| core_delivery | 1 |
| moving_delivery | 1 |
| coat_traps | 1 |

## Override usage

| Reason | Emissions | Correct | Incorrect |
| --- | --- | --- | --- |
| explicit_assembly_action | 60 | 60 | 0 |
| explicit_automotive_component | 14 | 14 | 0 |
| explicit_ceiling_fan_service | 14 | 14 | 0 |
| explicit_cleaning_request | 43 | 43 | 0 |
| explicit_electrical_request | 47 | 47 | 0 |
| explicit_event_context | 43 | 43 | 0 |
| explicit_handyman_hardware_work | 25 | 25 | 0 |
| explicit_handyman_repair | 8 | 8 | 0 |
| explicit_handyman_surface_repair | 31 | 31 | 0 |
| explicit_home_damage_assessment | 44 | 44 | 0 |
| explicit_leading_household_move | 41 | 41 | 0 |
| explicit_paint_coat_request | 6 | 6 | 0 |
| explicit_painting_request | 53 | 53 | 0 |
| explicit_patch_and_paint | 6 | 6 | 0 |
| explicit_pet_care_action | 46 | 46 | 0 |
| explicit_pickup_delivery | 61 | 61 | 0 |
| explicit_plumbing_request | 38 | 38 | 0 |
| explicit_wall_mounting_request | 14 | 14 | 0 |
| explicit_water_pressure_issue | 10 | 10 | 0 |
| explicit_yard_debris_work | 13 | 13 | 0 |
| pet_related_cleaning | 1 | 1 | 0 |

