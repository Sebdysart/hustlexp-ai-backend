# Blind holdout v2 post-run analysis

This report was generated from the saved one-shot result. It does not invoke the classifier.

## Global metrics

| Metric | Value |
| --- | --- |
| Total | 1000 |
| Concrete | 914 |
| Vague | 86 |
| Correct emitted | 642 |
| Incorrect emitted | 81 |
| Unnecessary abstentions | 191 |
| Correct abstentions | 81 |
| False concrete on vague | 5 |
| Emitted precision | 88.19% |
| Concrete accuracy | 70.24% |
| Concrete coverage | 79.10% |
| Unnecessary-abstention rate | 20.90% |
| False-vague rate | 5.81% |

## Per-category results

| Category | Total | Correct | Wrong | Abstained | Accuracy | Coverage | Precision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| assembly | 64 | 37 | 7 | 20 | 57.81% | 68.75% | 84.09% |
| auto | 59 | 39 | 0 | 20 | 66.10% | 66.10% | 100.00% |
| cleaning | 91 | 57 | 14 | 20 | 62.64% | 78.02% | 80.28% |
| delivery | 74 | 69 | 2 | 3 | 93.24% | 95.95% | 97.18% |
| electrical | 72 | 71 | 0 | 1 | 98.61% | 98.61% | 100.00% |
| events | 57 | 48 | 1 | 8 | 84.21% | 85.96% | 97.96% |
| handyman | 104 | 34 | 38 | 32 | 32.69% | 69.23% | 47.22% |
| home_services | 59 | 25 | 2 | 32 | 42.37% | 45.76% | 92.59% |
| moving | 72 | 59 | 0 | 13 | 81.94% | 81.94% | 100.00% |
| painting | 74 | 56 | 2 | 16 | 75.68% | 78.38% | 96.55% |
| pet_care | 59 | 36 | 13 | 10 | 61.02% | 83.05% | 73.47% |
| plumbing | 70 | 64 | 0 | 6 | 91.43% | 91.43% | 100.00% |
| vague | 86 | 0 | 5 | 81 | n/a | n/a | 0.00% |
| yard | 59 | 47 | 2 | 10 | 79.66% | 83.05% | 95.92% |

## Per-group results

| Group | Total | Correct | Wrong | Unnecessary abstain | Precision | Coverage |
| --- | --- | --- | --- | --- | --- | --- |
| assembly_handyman | 12 | 6 | 6 | 0 | 50.00% | 100.00% |
| cleaning_home | 12 | 1 | 0 | 11 | 100.00% | 8.33% |
| coat_traps | 12 | 6 | 0 | 6 | 100.00% | 50.00% |
| core_assembly | 40 | 18 | 7 | 15 | 72.00% | 62.50% |
| core_auto | 40 | 20 | 0 | 20 | 100.00% | 50.00% |
| core_cleaning | 40 | 36 | 0 | 4 | 100.00% | 90.00% |
| core_delivery | 40 | 39 | 0 | 1 | 100.00% | 97.50% |
| core_electrical | 40 | 39 | 0 | 1 | 100.00% | 97.50% |
| core_events | 40 | 31 | 1 | 8 | 96.88% | 80.00% |
| core_handyman | 40 | 22 | 6 | 12 | 78.57% | 70.00% |
| core_home_services | 40 | 19 | 1 | 20 | 95.00% | 50.00% |
| core_moving | 40 | 33 | 0 | 7 | 100.00% | 82.50% |
| core_painting | 40 | 35 | 0 | 5 | 100.00% | 87.50% |
| core_pet_care | 40 | 28 | 6 | 6 | 82.35% | 85.00% |
| core_plumbing | 40 | 34 | 0 | 6 | 100.00% | 85.00% |
| core_yard | 40 | 31 | 0 | 9 | 100.00% | 77.50% |
| events_vague | 12 | 7 | 5 | 0 | 54.55% | 100.00% |
| fan_traps | 12 | 6 | 0 | 6 | 100.00% | 50.00% |
| handyman_electrical | 24 | 12 | 7 | 5 | 63.16% | 79.17% |
| handyman_painting | 12 | 6 | 1 | 5 | 85.71% | 58.33% |
| handyman_plumbing | 24 | 12 | 9 | 3 | 57.14% | 87.50% |
| moving_delivery | 24 | 23 | 0 | 1 | 100.00% | 95.83% |
| multi_intent | 100 | 48 | 19 | 33 | 71.64% | 67.00% |
| noisy_short | 80 | 80 | 0 | 0 | 100.00% | 100.00% |
| override_traps | 40 | 24 | 12 | 4 | 66.67% | 90.00% |
| pet_clean | 12 | 6 | 6 | 0 | 50.00% | 100.00% |
| pressure_traps | 12 | 12 | 0 | 0 | 100.00% | 100.00% |
| vague | 80 | 80 | 0 | 0 | n/a | n/a |
| yard_debris | 12 | 9 | 0 | 3 | 100.00% | 75.00% |

## Wrong-emission root causes

| Root cause | Count |
| --- | --- |
| preprocessing | 30 |
| override false positive | 28 |
| oracle ambiguity | 12 |
| model boundary | 5 |
| training coverage | 4 |
| multi-intent ambiguity | 2 |

## All incorrect concrete emissions

| ID | Group | Raw input | Expected | Emitted | Top 1 / score | Top 2 / score | Margin | Source | Override | Root cause |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| blind2_0127 | core_assembly | Put together the bed frame this weekend and bring basic tools. | assembly | delivery | assembly / -0.044 | delivery / -0.643 | 0.599 | override | explicit_bring_task_object | override false positive |
| blind2_0131 | core_assembly | Assemble the desk before noon and bring basic tools. | assembly | delivery | assembly / -0.225 | delivery / -0.602 | 0.376 | override | explicit_bring_task_object | override false positive |
| blind2_0135 | core_assembly | Put together the dining table before noon and bring basic tools. | assembly | delivery | assembly / -0.524 | events / -0.530 | 0.006 | override | explicit_bring_task_object | override false positive |
| blind2_0147 | core_assembly | Put together the bed frame in my small apartment and bring basic tools. | assembly | delivery | assembly / 0.049 | handyman / -0.468 | 0.517 | override | explicit_bring_task_object | override false positive |
| blind2_0151 | core_assembly | Assemble the desk in the upstairs room and bring basic tools. | assembly | delivery | moving / -0.258 | assembly / -0.473 | 0.216 | override | explicit_bring_task_object | override false positive |
| blind2_0153 | core_assembly | Build the flat-pack wardrobe in the upstairs room. | assembly | moving | moving / 0.159 | handyman / -0.647 | 0.805 | ml | — | training coverage |
| blind2_0155 | core_assembly | Put together the dining table in the upstairs room and bring basic tools. | assembly | delivery | moving / -0.277 | assembly / -0.585 | 0.308 | override | explicit_bring_task_object | override false positive |
| blind2_0205 | core_handyman | Install a towel rack tomorrow. | handyman | assembly | assembly / -0.132 | handyman / -0.706 | 0.574 | ml | — | training coverage |
| blind2_0207 | core_handyman | Fix the loose cabinet hinge this weekend and bring basic tools. | handyman | delivery | handyman / 0.222 | cleaning / -0.699 | 0.922 | override | explicit_bring_task_object | override false positive |
| blind2_0209 | core_handyman | Mount a mirror on the wall this weekend. | handyman | assembly | assembly / -0.021 | delivery / -0.390 | 0.369 | override | explicit_wall_mounting_request | oracle ambiguity |
| blind2_0227 | core_handyman | Fix the loose cabinet hinge in my small apartment and bring basic tools. | handyman | delivery | handyman / 0.399 | moving / -0.650 | 1.049 | override | explicit_bring_task_object | override false positive |
| blind2_0229 | core_handyman | Mount a mirror on the wall in my small apartment. | handyman | assembly | assembly / 0.062 | delivery / -0.263 | 0.325 | override | explicit_wall_mounting_request | oracle ambiguity |
| blind2_0230 | core_handyman | Install a towel rack in my small apartment please. | handyman | assembly | assembly / -0.006 | handyman / -0.566 | 0.560 | ml | — | training coverage |
| blind2_0243 | core_home_services | Check a soft damaged wall section tomorrow and bring basic tools. | home_services | handyman | handyman / -0.048 | home_services / -0.907 | 0.860 | ml | — | oracle ambiguity |
| blind2_0348 | core_events | Clean up after a graduation party in my small apartment; that is the main task. | events | cleaning | cleaning / 0.323 | events / -0.181 | 0.504 | ml | — | multi-intent ambiguity |
| blind2_0362 | core_pet_care | Feed my cat and clean the litter box tomorrow please. | pet_care | cleaning | pet_care / 0.389 | cleaning / -0.684 | 1.072 | override | pet_related_cleaning | override false positive |
| blind2_0367 | core_pet_care | Feed my cat and clean the litter box this weekend and bring basic tools. | pet_care | delivery | pet_care / 0.232 | cleaning / -0.484 | 0.715 | override | explicit_bring_task_object | override false positive |
| blind2_0372 | core_pet_care | Feed my cat and clean the litter box before noon; that is the main task. | pet_care | cleaning | pet_care / 0.490 | cleaning / -0.570 | 1.059 | override | pet_related_cleaning | override false positive |
| blind2_0377 | core_pet_care | Feed my cat and clean the litter box as soon as possible. | pet_care | cleaning | pet_care / 0.537 | cleaning / -0.556 | 1.092 | override | pet_related_cleaning | override false positive |
| blind2_0382 | core_pet_care | Feed my cat and clean the litter box before guests arrive please. | pet_care | cleaning | pet_care / 0.340 | cleaning / -0.450 | 0.790 | override | pet_related_cleaning | override false positive |
| blind2_0387 | core_pet_care | Feed my cat and clean the litter box in my small apartment and bring basic tools. | pet_care | delivery | pet_care / 0.095 | cleaning / -0.488 | 0.583 | override | explicit_bring_task_object | override false positive |
| blind2_0545 | handyman_plumbing | Patch the wall behind the sink; the plumbing is fine. | handyman | plumbing | plumbing / 0.697 | handyman / -0.148 | 0.845 | ml | — | preprocessing |
| blind2_0546 | handyman_plumbing | Patch the wall behind the sink; the plumbing is fine. Please focus only on that. | handyman | plumbing | plumbing / 0.592 | handyman / -0.214 | 0.806 | ml | — | preprocessing |
| blind2_0547 | handyman_plumbing | Patch the wall behind the sink; the plumbing is fine. That is the main task. | handyman | plumbing | plumbing / 0.590 | handyman / -0.220 | 0.811 | ml | — | preprocessing |
| blind2_0548 | handyman_plumbing | Patch the wall behind the sink; the plumbing is fine. No other service is needed. | handyman | plumbing | plumbing / 0.700 | handyman / -0.673 | 1.373 | ml | — | preprocessing |
| blind2_0549 | handyman_plumbing | Patch the wall behind the sink; the plumbing is fine. Need this done tomorrow. | handyman | plumbing | plumbing / 0.458 | handyman / -0.285 | 0.743 | ml | — | preprocessing |
| blind2_0550 | handyman_plumbing | Patch the wall behind the sink; the plumbing is fine. This is the only issue. | handyman | plumbing | plumbing / 0.818 | handyman / -0.158 | 0.976 | ml | — | preprocessing |
| blind2_0557 | handyman_plumbing | Mount a mirror above the bathroom sink. | handyman | assembly | assembly / -0.166 | handyman / -0.563 | 0.398 | override | explicit_wall_mounting_request | oracle ambiguity |
| blind2_0559 | handyman_plumbing | Mount a mirror above the bathroom sink. That is the main task. | handyman | assembly | assembly / -0.297 | handyman / -0.680 | 0.383 | override | explicit_wall_mounting_request | oracle ambiguity |
| blind2_0561 | handyman_plumbing | Mount a mirror above the bathroom sink. Need this done tomorrow. | handyman | assembly | assembly / 0.007 | delivery / -0.573 | 0.580 | override | explicit_wall_mounting_request | oracle ambiguity |
| blind2_0569 | handyman_electrical | Patch the wall beside the electrical panel; do not touch the wiring. | handyman | electrical | electrical / 0.687 | handyman / -0.050 | 0.737 | override | explicit_electrical_request | preprocessing |
| blind2_0570 | handyman_electrical | Patch the wall beside the electrical panel; do not touch the wiring. Please focus only on that. | handyman | electrical | electrical / 0.675 | handyman / -0.115 | 0.790 | override | explicit_electrical_request | preprocessing |
| blind2_0571 | handyman_electrical | Patch the wall beside the electrical panel; do not touch the wiring. That is the main task. | handyman | electrical | electrical / 0.624 | handyman / -0.125 | 0.749 | override | explicit_electrical_request | preprocessing |
| blind2_0572 | handyman_electrical | Patch the wall beside the electrical panel; do not touch the wiring. No other service is needed. | handyman | electrical | electrical / 0.540 | handyman / -0.560 | 1.100 | override | explicit_electrical_request | preprocessing |
| blind2_0573 | handyman_electrical | Patch the wall beside the electrical panel; do not touch the wiring. Need this done tomorrow. | handyman | electrical | electrical / 0.634 | handyman / -0.132 | 0.766 | override | explicit_electrical_request | preprocessing |
| blind2_0574 | handyman_electrical | Patch the wall beside the electrical panel; do not touch the wiring. This is the only issue. | handyman | electrical | electrical / 0.749 | handyman / -0.037 | 0.786 | override | explicit_electrical_request | preprocessing |
| blind2_0583 | handyman_electrical | Repair the ceiling around the fan; the fan works fine. That is the main task. | handyman | electrical | electrical / 0.016 | home_services / -0.286 | 0.302 | override | explicit_electrical_request | override false positive |
| blind2_0604 | handyman_painting | Patch two holes and repaint the whole wall. This is the only issue. | painting | handyman | handyman / 0.331 | painting / -0.326 | 0.657 | ml | — | training coverage |
| blind2_0611 | assembly_handyman | Mount an already assembled bookshelf to the wall. | handyman | assembly | assembly / 0.793 | moving / -0.716 | 1.508 | ml | — | oracle ambiguity |
| blind2_0612 | assembly_handyman | Mount an already assembled bookshelf to the wall. Please focus only on that. | handyman | assembly | assembly / 0.603 | moving / -0.545 | 1.148 | ml | — | oracle ambiguity |
| blind2_0613 | assembly_handyman | Mount an already assembled bookshelf to the wall. That is the main task. | handyman | assembly | assembly / 0.565 | moving / -0.437 | 1.001 | ml | — | oracle ambiguity |
| blind2_0614 | assembly_handyman | Mount an already assembled bookshelf to the wall. No other service is needed. | handyman | assembly | assembly / -0.031 | home_services / -0.754 | 0.722 | ml | — | oracle ambiguity |
| blind2_0615 | assembly_handyman | Mount an already assembled bookshelf to the wall. Need this done tomorrow. | handyman | assembly | assembly / 0.727 | moving / -0.791 | 1.518 | ml | — | oracle ambiguity |
| blind2_0616 | assembly_handyman | Mount an already assembled bookshelf to the wall. This is the only issue. | handyman | assembly | assembly / 0.553 | moving / -0.597 | 1.150 | ml | — | oracle ambiguity |
| blind2_0641 | pet_clean | Feed my cat and clean its litter box. | pet_care | cleaning | pet_care / 0.330 | cleaning / -0.469 | 0.799 | override | pet_related_cleaning | override false positive |
| blind2_0642 | pet_clean | Feed my cat and clean its litter box. Please focus only on that. | pet_care | cleaning | pet_care / 0.352 | cleaning / -0.335 | 0.687 | override | pet_related_cleaning | override false positive |
| blind2_0643 | pet_clean | Feed my cat and clean its litter box. That is the main task. | pet_care | cleaning | pet_care / 0.268 | cleaning / -0.377 | 0.645 | override | pet_related_cleaning | override false positive |
| blind2_0644 | pet_clean | Feed my cat and clean its litter box. No other service is needed. | pet_care | cleaning | pet_care / 0.225 | cleaning / -0.598 | 0.823 | override | pet_related_cleaning | override false positive |
| blind2_0645 | pet_clean | Feed my cat and clean its litter box. Need this done tomorrow. | pet_care | cleaning | pet_care / 0.169 | cleaning / -0.533 | 0.702 | override | pet_related_cleaning | override false positive |
| blind2_0646 | pet_clean | Feed my cat and clean its litter box. This is the only issue. | pet_care | cleaning | pet_care / 0.337 | cleaning / -0.577 | 0.914 | override | pet_related_cleaning | override false positive |
| blind2_0702 | multi_intent | Clean the kitchen; the loose faucet can be ignored. | cleaning | plumbing | plumbing / 0.460 | cleaning / -0.622 | 1.082 | ml | — | preprocessing |
| blind2_0706 | multi_intent | Patch the wall; painting is not needed. | handyman | painting | painting / 0.387 | handyman / -0.680 | 1.067 | override | explicit_painting_request | preprocessing |
| blind2_0714 | multi_intent | Clean the house after the party; no event help is needed. | cleaning | events | events / 0.618 | cleaning / -0.503 | 1.121 | ml | — | preprocessing |
| blind2_0722 | multi_intent | Clean the kitchen; the loose faucet can be ignored. The first part is the priority. | cleaning | plumbing | plumbing / 0.511 | cleaning / -0.629 | 1.140 | ml | — | preprocessing |
| blind2_0726 | multi_intent | Patch the wall; painting is not needed. The first part is the priority. | handyman | painting | painting / 0.258 | handyman / -0.841 | 1.099 | override | explicit_painting_request | preprocessing |
| blind2_0734 | multi_intent | Clean the house after the party; no event help is needed. The first part is the priority. | cleaning | events | events / 0.584 | cleaning / -0.519 | 1.103 | ml | — | preprocessing |
| blind2_0736 | multi_intent | Pick up the replacement car battery from the store and deliver it. The first part is the priority. | delivery | auto | auto / 0.255 | delivery / 0.129 | 0.126 | override | explicit_automotive_component | override false positive |
| blind2_0742 | multi_intent | Clean the kitchen; the loose faucet can be ignored. Everything else is secondary. | cleaning | plumbing | plumbing / 0.370 | cleaning / -0.517 | 0.887 | ml | — | preprocessing |
| blind2_0746 | multi_intent | Patch the wall; painting is not needed. Everything else is secondary. | handyman | painting | painting / 0.251 | handyman / -0.821 | 1.072 | override | explicit_painting_request | preprocessing |
| blind2_0748 | multi_intent | Patch the drywall near the outlet; the outlet itself works. Everything else is secondary. | handyman | electrical | electrical / 0.037 | handyman / -0.634 | 0.671 | ml | — | preprocessing |
| blind2_0754 | multi_intent | Clean the house after the party; no event help is needed. Everything else is secondary. | cleaning | events | events / 0.626 | cleaning / -0.517 | 1.143 | ml | — | preprocessing |
| blind2_0756 | multi_intent | Pick up the replacement car battery from the store and deliver it. Everything else is secondary. | delivery | auto | auto / 0.201 | delivery / -0.049 | 0.250 | override | explicit_automotive_component | override false positive |
| blind2_0762 | multi_intent | Clean the kitchen; the loose faucet can be ignored. Keep the job focused on the main request. | cleaning | plumbing | plumbing / 0.408 | cleaning / -0.480 | 0.887 | ml | — | preprocessing |
| blind2_0766 | multi_intent | Patch the wall; painting is not needed. Keep the job focused on the main request. | handyman | painting | painting / 0.466 | electrical / -0.968 | 1.434 | override | explicit_painting_request | preprocessing |
| blind2_0771 | multi_intent | Walk my dog, then wipe the muddy paws before coming inside. Keep the job focused on the main request. | pet_care | cleaning | cleaning / 0.265 | pet_care / -0.287 | 0.551 | ml | — | multi-intent ambiguity |
| blind2_0774 | multi_intent | Clean the house after the party; no event help is needed. Keep the job focused on the main request. | cleaning | events | events / 0.566 | cleaning / -0.414 | 0.980 | ml | — | preprocessing |
| blind2_0782 | multi_intent | Clean the kitchen; the loose faucet can be ignored. That main task is what I care about. | cleaning | plumbing | plumbing / 0.171 | cleaning / -0.360 | 0.531 | ml | — | preprocessing |
| blind2_0786 | multi_intent | Patch the wall; painting is not needed. That main task is what I care about. | handyman | painting | painting / 0.148 | handyman / -0.587 | 0.736 | override | explicit_painting_request | preprocessing |
| blind2_0794 | multi_intent | Clean the house after the party; no event help is needed. That main task is what I care about. | cleaning | events | events / 0.531 | cleaning / -0.434 | 0.965 | ml | — | preprocessing |
| blind2_0961 | override_traps | Clean the ceiling fan blades; the fan works fine. | cleaning | electrical | electrical / 0.140 | home_services / -0.536 | 0.676 | ml | — | model boundary |
| blind2_0962 | override_traps | Patch the wall beside the sink; no plumbing work. That is all. | handyman | plumbing | plumbing / 0.504 | handyman / -0.195 | 0.699 | ml | — | preprocessing |
| blind2_0963 | override_traps | Paint around the electrical panel without touching it. | painting | electrical | electrical / 0.443 | painting / -0.317 | 0.760 | ml | — | model boundary |
| blind2_0964 | override_traps | Clear leaves around the outdoor faucet; do not repair the faucet. That is all. | yard | plumbing | plumbing / -0.125 | yard / -0.510 | 0.385 | override | explicit_plumbing_request | override false positive |
| blind2_0965 | override_traps | Clean the car interior; no auto repair needed. | cleaning | auto | auto / 0.101 | cleaning / -0.605 | 0.706 | ml | — | model boundary |
| blind2_0972 | override_traps | Repair the vanity cabinet under the sink. That is all. | handyman | plumbing | plumbing / -0.060 | handyman / -0.236 | 0.176 | override | explicit_plumbing_request | override false positive |
| blind2_0981 | override_traps | Clean the ceiling fan blades; the fan works fine (request 2). | cleaning | electrical | electrical / 0.058 | home_services / -0.471 | 0.528 | ml | — | model boundary |
| blind2_0982 | override_traps | Patch the wall beside the sink; no plumbing work. That is all (request 2). | handyman | plumbing | plumbing / 0.531 | handyman / -0.175 | 0.706 | ml | — | preprocessing |
| blind2_0984 | override_traps | Clear leaves around the outdoor faucet; do not repair the faucet. That is all (request 2). | yard | plumbing | plumbing / -0.143 | yard / -0.538 | 0.395 | override | explicit_plumbing_request | override false positive |
| blind2_0985 | override_traps | Clean the car interior; no auto repair needed (request 2). | cleaning | auto | auto / 0.116 | handyman / -0.595 | 0.710 | ml | — | model boundary |
| blind2_0991 | override_traps | Inspect water damage near the toilet; the toilet works (request 2). | home_services | plumbing | plumbing / -0.025 | home_services / -0.111 | 0.086 | override | explicit_plumbing_request | override false positive |
| blind2_0992 | override_traps | Repair the vanity cabinet under the sink. That is all (request 2). | handyman | plumbing | plumbing / 0.057 | handyman / -0.210 | 0.266 | override | explicit_plumbing_request | override false positive |

## False concrete classifications on vague cases

| ID | Raw input | Emitted | Margin | Source | Override |
| --- | --- | --- | --- | --- | --- |
| blind2_0635 | Anniversary dinner with my spouse at home. | events | 1.211 | ml | — |
| blind2_0636 | Anniversary dinner with my spouse at home. Please focus only on that. | events | 1.350 | ml | — |
| blind2_0638 | Anniversary dinner with my spouse at home. No other service is needed. | events | 1.571 | ml | — |
| blind2_0639 | Anniversary dinner with my spouse at home. Need this done tomorrow. | events | 1.268 | ml | — |
| blind2_0640 | Anniversary dinner with my spouse at home. This is the only issue. | events | 1.213 | ml | — |

## Abstention distribution

### By expected category

| Category | Count |
| --- | --- |
| handyman | 32 |
| home_services | 32 |
| cleaning | 20 |
| assembly | 20 |
| auto | 20 |
| painting | 16 |
| moving | 13 |
| yard | 10 |
| pet_care | 10 |
| events | 8 |
| plumbing | 6 |
| delivery | 3 |
| electrical | 1 |

### By evaluation group

| Group | Count |
| --- | --- |
| multi_intent | 33 |
| core_home_services | 20 |
| core_auto | 20 |
| core_assembly | 15 |
| core_handyman | 12 |
| cleaning_home | 11 |
| core_yard | 9 |
| core_events | 8 |
| core_moving | 7 |
| core_pet_care | 6 |
| core_plumbing | 6 |
| fan_traps | 6 |
| coat_traps | 6 |
| core_painting | 5 |
| handyman_electrical | 5 |
| handyman_painting | 5 |
| core_cleaning | 4 |
| override_traps | 4 |
| handyman_plumbing | 3 |
| yard_debris | 3 |
| core_delivery | 1 |
| core_electrical | 1 |
| moving_delivery | 1 |

## Override usage

| Reason | Emissions | Correct | Incorrect |
| --- | --- | --- | --- |
| explicit_assembly_action | 37 | 37 | 0 |
| explicit_automotive_component | 27 | 25 | 2 |
| explicit_bring_task_object | 18 | 8 | 10 |
| explicit_ceiling_fan_service | 14 | 14 | 0 |
| explicit_cleaning_request | 39 | 39 | 0 |
| explicit_electrical_request | 58 | 51 | 7 |
| explicit_event_context | 44 | 44 | 0 |
| explicit_handyman_repair | 14 | 14 | 0 |
| explicit_leading_household_move | 34 | 34 | 0 |
| explicit_paint_coat_request | 5 | 5 | 0 |
| explicit_painting_request | 55 | 50 | 5 |
| explicit_pet_care_action | 21 | 21 | 0 |
| explicit_pickup_delivery | 46 | 46 | 0 |
| explicit_plumbing_request | 69 | 64 | 5 |
| explicit_wall_mounting_request | 5 | 0 | 5 |
| explicit_yard_debris_work | 13 | 13 | 0 |
| pet_related_cleaning | 11 | 1 | 10 |

