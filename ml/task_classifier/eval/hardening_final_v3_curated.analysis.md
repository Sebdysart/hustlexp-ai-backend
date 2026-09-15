# Classifier evaluation post-run analysis

This report was generated from a saved evaluation result. It does not invoke the classifier.

## Global metrics

| Metric | Value |
| --- | --- |
| Total | 1600 |
| Concrete | 1530 |
| Vague | 70 |
| Correct emitted | 1351 |
| Incorrect emitted | 0 |
| Unnecessary abstentions | 179 |
| Correct abstentions | 70 |
| False concrete on vague | 0 |
| Emitted precision | 100.00% |
| Concrete accuracy | 88.30% |
| Concrete coverage | 88.30% |
| Unnecessary-abstention rate | 11.70% |
| False-vague rate | 0.00% |

## Per-category results

| Category | Total | Correct | Wrong | Abstained | Accuracy | Coverage | Precision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| assembly | 130 | 130 | 0 | 0 | 100.00% | 100.00% | 100.00% |
| auto | 94 | 88 | 0 | 6 | 93.62% | 93.62% | 100.00% |
| cleaning | 133 | 113 | 0 | 20 | 84.96% | 84.96% | 100.00% |
| delivery | 134 | 130 | 0 | 4 | 97.01% | 97.01% | 100.00% |
| electrical | 115 | 94 | 0 | 21 | 81.74% | 81.74% | 100.00% |
| events | 101 | 53 | 0 | 48 | 52.48% | 52.48% | 100.00% |
| handyman | 169 | 150 | 0 | 19 | 88.76% | 88.76% | 100.00% |
| home_services | 105 | 80 | 0 | 25 | 76.19% | 76.19% | 100.00% |
| moving | 125 | 113 | 0 | 12 | 90.40% | 90.40% | 100.00% |
| painting | 118 | 104 | 0 | 14 | 88.14% | 88.14% | 100.00% |
| pet_care | 100 | 100 | 0 | 0 | 100.00% | 100.00% | 100.00% |
| plumbing | 109 | 104 | 0 | 5 | 95.41% | 95.41% | 100.00% |
| vague | 70 | 0 | 0 | 70 | n/a | n/a | n/a |
| yard | 97 | 92 | 0 | 5 | 94.85% | 94.85% | 100.00% |

## Per-group results

| Group | Total | Correct | Wrong | Unnecessary abstain | Precision | Coverage |
| --- | --- | --- | --- | --- | --- | --- |
| assembly_handyman | 40 | 30 | 0 | 10 | 100.00% | 75.00% |
| cleaning_home | 20 | 10 | 0 | 10 | 100.00% | 50.00% |
| conversational_extra | 409 | 346 | 0 | 63 | 100.00% | 84.60% |
| core_assembly | 45 | 45 | 0 | 0 | 100.00% | 100.00% |
| core_auto | 45 | 40 | 0 | 5 | 100.00% | 88.89% |
| core_cleaning | 46 | 42 | 0 | 4 | 100.00% | 91.30% |
| core_delivery | 44 | 40 | 0 | 4 | 100.00% | 90.91% |
| core_electrical | 47 | 37 | 0 | 10 | 100.00% | 78.72% |
| core_events | 48 | 31 | 0 | 17 | 100.00% | 64.58% |
| core_handyman | 45 | 37 | 0 | 8 | 100.00% | 82.22% |
| core_home_services | 46 | 35 | 0 | 11 | 100.00% | 76.09% |
| core_moving | 46 | 45 | 0 | 1 | 100.00% | 97.83% |
| core_painting | 44 | 37 | 0 | 7 | 100.00% | 84.09% |
| core_pet_care | 42 | 42 | 0 | 0 | 100.00% | 100.00% |
| core_plumbing | 40 | 35 | 0 | 5 | 100.00% | 87.50% |
| core_yard | 47 | 47 | 0 | 0 | 100.00% | 100.00% |
| events_vague | 20 | 20 | 0 | 0 | 100.00% | 100.00% |
| handyman_electrical | 40 | 40 | 0 | 0 | 100.00% | 100.00% |
| handyman_painting | 20 | 20 | 0 | 0 | 100.00% | 100.00% |
| handyman_plumbing | 40 | 40 | 0 | 0 | 100.00% | 100.00% |
| moving_delivery | 60 | 60 | 0 | 0 | 100.00% | 100.00% |
| multi_intent | 36 | 32 | 0 | 4 | 100.00% | 88.89% |
| noisy_short | 130 | 127 | 0 | 3 | 100.00% | 97.69% |
| override_traps | 120 | 104 | 0 | 16 | 100.00% | 86.67% |
| pet_clean | 20 | 19 | 0 | 1 | 100.00% | 95.00% |
| vague | 60 | 60 | 0 | 0 | n/a | n/a |

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
| events | 48 |
| home_services | 25 |
| electrical | 21 |
| cleaning | 20 |
| handyman | 19 |
| painting | 14 |
| moving | 12 |
| auto | 6 |
| plumbing | 5 |
| yard | 5 |
| delivery | 4 |

### By evaluation group

| Group | Count |
| --- | --- |
| conversational_extra | 63 |
| core_events | 17 |
| override_traps | 16 |
| core_home_services | 11 |
| core_electrical | 10 |
| cleaning_home | 10 |
| assembly_handyman | 10 |
| core_handyman | 8 |
| core_painting | 7 |
| core_plumbing | 5 |
| core_auto | 5 |
| multi_intent | 4 |
| core_delivery | 4 |
| core_cleaning | 4 |
| noisy_short | 3 |
| core_moving | 1 |
| pet_clean | 1 |

## Override usage

| Reason | Emissions | Correct | Incorrect |
| --- | --- | --- | --- |
| explicit_assembly_action | 69 | 69 | 0 |
| explicit_automotive_component | 37 | 37 | 0 |
| explicit_automotive_context | 2 | 2 | 0 |
| explicit_bring_task_object | 11 | 11 | 0 |
| explicit_ceiling_fan_service | 17 | 17 | 0 |
| explicit_cleaning_request | 80 | 80 | 0 |
| explicit_direct_plumbing_work | 36 | 36 | 0 |
| explicit_electrical_request | 74 | 74 | 0 |
| explicit_event_context | 53 | 53 | 0 |
| explicit_handyman_hardware_work | 37 | 37 | 0 |
| explicit_handyman_repair | 36 | 36 | 0 |
| explicit_handyman_surface_repair | 57 | 57 | 0 |
| explicit_home_damage_assessment | 66 | 66 | 0 |
| explicit_internal_relocation | 98 | 98 | 0 |
| explicit_leading_household_move | 15 | 15 | 0 |
| explicit_paint_coat_request | 5 | 5 | 0 |
| explicit_painting_request | 55 | 55 | 0 |
| explicit_patch_and_paint | 12 | 12 | 0 |
| explicit_pet_care_action | 100 | 100 | 0 |
| explicit_pickup_delivery | 119 | 119 | 0 |
| explicit_plumbing_request | 22 | 22 | 0 |
| explicit_wall_mounting_request | 61 | 61 | 0 |
| explicit_water_pressure_issue | 18 | 18 | 0 |
| explicit_yard_debris_work | 19 | 19 | 0 |
| explicit_yard_maintenance | 62 | 62 | 0 |

