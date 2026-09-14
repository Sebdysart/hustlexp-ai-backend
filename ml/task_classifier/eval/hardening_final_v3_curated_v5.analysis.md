# Classifier evaluation post-run analysis

This report was generated from a saved evaluation result. It does not invoke the classifier.

## Global metrics

| Metric | Value |
| --- | --- |
| Total | 1600 |
| Concrete | 1530 |
| Vague | 70 |
| Correct emitted | 1457 |
| Incorrect emitted | 0 |
| Unnecessary abstentions | 73 |
| Correct abstentions | 70 |
| False concrete on vague | 0 |
| Emitted precision | 100.00% |
| Concrete accuracy | 95.23% |
| Concrete coverage | 95.23% |
| Unnecessary-abstention rate | 4.77% |
| False-vague rate | 0.00% |

## Per-category results

| Category | Total | Correct | Wrong | Abstained | Accuracy | Coverage | Precision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| assembly | 130 | 130 | 0 | 0 | 100.00% | 100.00% | 100.00% |
| auto | 94 | 89 | 0 | 5 | 94.68% | 94.68% | 100.00% |
| cleaning | 133 | 124 | 0 | 9 | 93.23% | 93.23% | 100.00% |
| delivery | 134 | 134 | 0 | 0 | 100.00% | 100.00% | 100.00% |
| electrical | 115 | 111 | 0 | 4 | 96.52% | 96.52% | 100.00% |
| events | 101 | 101 | 0 | 0 | 100.00% | 100.00% | 100.00% |
| handyman | 169 | 150 | 0 | 19 | 88.76% | 88.76% | 100.00% |
| home_services | 105 | 104 | 0 | 1 | 99.05% | 99.05% | 100.00% |
| moving | 125 | 113 | 0 | 12 | 90.40% | 90.40% | 100.00% |
| painting | 118 | 105 | 0 | 13 | 88.98% | 88.98% | 100.00% |
| pet_care | 100 | 100 | 0 | 0 | 100.00% | 100.00% | 100.00% |
| plumbing | 109 | 104 | 0 | 5 | 95.41% | 95.41% | 100.00% |
| vague | 70 | 0 | 0 | 70 | n/a | n/a | n/a |
| yard | 97 | 92 | 0 | 5 | 94.85% | 94.85% | 100.00% |

## Per-group results

| Group | Total | Correct | Wrong | Unnecessary abstain | Precision | Coverage |
| --- | --- | --- | --- | --- | --- | --- |
| assembly_handyman | 40 | 30 | 0 | 10 | 100.00% | 75.00% |
| cleaning_home | 20 | 20 | 0 | 0 | 100.00% | 100.00% |
| conversational_extra | 409 | 397 | 0 | 12 | 100.00% | 97.07% |
| core_assembly | 45 | 45 | 0 | 0 | 100.00% | 100.00% |
| core_auto | 45 | 40 | 0 | 5 | 100.00% | 88.89% |
| core_cleaning | 46 | 42 | 0 | 4 | 100.00% | 91.30% |
| core_delivery | 44 | 44 | 0 | 0 | 100.00% | 100.00% |
| core_electrical | 47 | 43 | 0 | 4 | 100.00% | 91.49% |
| core_events | 48 | 48 | 0 | 0 | 100.00% | 100.00% |
| core_handyman | 45 | 37 | 0 | 8 | 100.00% | 82.22% |
| core_home_services | 46 | 46 | 0 | 0 | 100.00% | 100.00% |
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
| noisy_short | 130 | 129 | 0 | 1 | 100.00% | 99.23% |
| override_traps | 120 | 108 | 0 | 12 | 100.00% | 90.00% |
| pet_clean | 20 | 20 | 0 | 0 | 100.00% | 100.00% |
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
| handyman | 19 |
| painting | 13 |
| moving | 12 |
| cleaning | 9 |
| plumbing | 5 |
| auto | 5 |
| yard | 5 |
| electrical | 4 |
| home_services | 1 |

### By evaluation group

| Group | Count |
| --- | --- |
| conversational_extra | 12 |
| override_traps | 12 |
| assembly_handyman | 10 |
| core_handyman | 8 |
| core_painting | 7 |
| core_plumbing | 5 |
| core_auto | 5 |
| multi_intent | 4 |
| core_electrical | 4 |
| core_cleaning | 4 |
| core_moving | 1 |
| noisy_short | 1 |

## Override usage

| Reason | Emissions | Correct | Incorrect |
| --- | --- | --- | --- |
| explicit_assembly_action | 69 | 69 | 0 |
| explicit_automotive_component | 37 | 37 | 0 |
| explicit_automotive_context | 2 | 2 | 0 |
| explicit_bring_task_object | 11 | 11 | 0 |
| explicit_ceiling_fan_service | 17 | 17 | 0 |
| explicit_cleaning_request | 91 | 91 | 0 |
| explicit_direct_electrical_work | 81 | 81 | 0 |
| explicit_direct_plumbing_work | 36 | 36 | 0 |
| explicit_electrical_request | 10 | 10 | 0 |
| explicit_event_context | 95 | 95 | 0 |
| explicit_handyman_hardware_work | 37 | 37 | 0 |
| explicit_handyman_repair | 36 | 36 | 0 |
| explicit_handyman_surface_repair | 57 | 57 | 0 |
| explicit_home_damage_assessment | 77 | 77 | 0 |
| explicit_internal_relocation | 98 | 98 | 0 |
| explicit_leading_household_move | 15 | 15 | 0 |
| explicit_paint_coat_request | 5 | 5 | 0 |
| explicit_painting_request | 55 | 55 | 0 |
| explicit_patch_and_paint | 12 | 12 | 0 |
| explicit_pet_care_action | 100 | 100 | 0 |
| explicit_pickup_delivery | 123 | 123 | 0 |
| explicit_plumbing_request | 22 | 22 | 0 |
| explicit_wall_mounting_request | 61 | 61 | 0 |
| explicit_water_pressure_issue | 18 | 18 | 0 |
| explicit_yard_debris_work | 19 | 19 | 0 |
| explicit_yard_maintenance | 62 | 62 | 0 |

