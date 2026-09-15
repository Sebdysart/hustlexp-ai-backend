# Classifier override audit

## Resolution policy

Overrides do not act as an unrestricted parallel classifier. Most can emit only when their category agrees with raw SVM top-1 and the raw margin is at least 0.30. A small low-margin allowlist covers explicit automotive components, cleaning requests, home-damage assessments, home-services domains, leading household moves, painting requests, and plumbing requests. Ten direct action/target boundaries may change category: non-negated assembly actions, transport-qualified `bring`, pickup/delivery, direct pet-care actions, wall mounting, installed handyman hardware, patio screen-door repair, patch-and-paint, targeted electrical work, and explicit ceiling-fan service. Category changes are also allowed for a small affirmative fallback only when the raw top category was explicitly excluded by the user.

The 380-case development audit records only the first matching override because `findClassificationOverride` is ordered. A rule with wrong semantic matches can therefore still be safe at runtime when the agreement/margin gate rejects it.

| Override reason | Purpose and trigger | Main false-positive surface | Status |
| --- | --- | --- | --- |
| `explicit_patch_and_paint` | Patch/fill/repair a wall-like surface and paint it, in either object/action order. | A repair mentioned near unrelated future painting. | Retained as a narrow authoritative painting boundary; required by established regressions. |
| `explicit_ceiling_fan_service` | Explicit repair/install/replace/service of a ceiling fan. | Mechanical-only fan work could be debated. | Retained as an authoritative electrical product-policy boundary. |
| `explicit_painting_request` | Paint verb plus a supported paint surface. | Cleaning paint, or a secondary paint clause. | Retained but confidence-only; cannot replace a conflicting model prediction. |
| `explicit_paint_coat_request` | Explicit coat count plus a paint surface. | A product description rather than requested work. | Retained, confidence-only; no development rescue, candidate for future deletion after more data. |
| `explicit_plumbing_request` | Plumbing fixture plus plumbing issue/action vocabulary. | Handyman work spatially near a sink, pipe, or toilet. | Retained as agreement-gated confidence evidence; four final development rescues. |
| `explicit_water_pressure_issue` | Low/weak water-pressure phrasing. | Non-plumbing pressure contexts. | Retained, agreement/margin gated; training can likely replace it with more context diversity. |
| `explicit_historical_plumbing_leak` | Leak/drip described as stopped or no longer active, excluding common non-plumbing domains. | Historical building/appliance leaks. | Retained, agreement/margin gated; narrow but needs more adversarial coverage. |
| `explicit_leading_household_move` | Leading move/carry/relocate/take action plus household objects. | Delivery phrasing without an address/package signal. | Retained on the low-margin allowlist; three final development rescues. |
| `explicit_household_moving_request` | Household movement appears after another competing task action. | Multi-intent requests where moving is secondary. | Retained but agreement/margin gated; its only final development match was semantically wrong and was rejected. |
| `explicit_wall_mounting_request` | Mount/install/hang shelves, TV, mirrors, or cabinets; incidental electrical context is allowed only when explicitly excluded. | Repair or installation that belongs to handyman. | Retained as an authoritative assembly taxonomy boundary. |
| `explicit_bring_task_object` | `bring` plus a deliverable object, excluding provider tools/materials/vehicles. | In-room movement or provider-owned objects. | Retained as a narrow authoritative delivery boundary; final cases are currently model-confident. |
| `explicit_pickup_delivery` | Pickup/collect/deliver/transport plus destination or transport semantics. | Local moving that includes pickup wording. | Retained as authoritative; three final development rescues. |
| `explicit_yard_tool_cleanup` | Rake plus blower and outdoor/cleanup context. | Generic cleanup using those tools. | Retained, agreement/margin gated; no final development hit, so fresh blind evidence should determine its future. |
| `explicit_yard_debris_work` | Bag/pile/trim/remove yard debris terms. | Indoor disposal involving branches or clippings. | Retained, confidence-only; currently redundant on final development. |
| `explicit_screen_door_repair` | Fix/repair/mend a patio or screen door. | Specialist door-system work. | Retained as authoritative handyman taxonomy policy. |
| `explicit_handyman_repair` | Explicit repair/tightening of fence, gate, rail, hinge, doors, or brackets, excluding electrical context. | A first-class specialist task that shares a hardware noun. | Retained, agreement/margin gated; the narrower installed-hardware rule is authoritative. |
| `explicit_home_services_domain` | Inspection/service/repair of roof, chimney, vents, window mechanisms, or garage doors. | Small handyman repairs within those structures. | Retained on low-margin allowlist; two final development rescues. |
| `explicit_automotive_context` | Transmission/wipers plus automotive or repair context. | Household equipment using similar terms. | Retained, agreement/margin gated; more auto data could replace it. |
| `explicit_automotive_component` | Vehicle context plus an automotive component. | Delivery/moving requests involving a vehicle and loose parts. | Retained on low-margin allowlist; one final development rescue. |
| `explicit_cleaning_request` | Cleaning verb plus property/room/surface context, excluding event context. | Cleanup as a secondary action. | Retained on low-margin allowlist; two final development rescues. |
| `explicit_electrical_request` | Direct electrical action/target or target/fault grammar. | Handyman work located beside an electrical fixture. | Retained as an authoritative targeted boundary; exclusions block incidental fixtures and functioning equipment. |
| `pet_related_cleaning` | Pet debris/stain/odor plus a cleaning action. | Pet-care tasks that also clean a cage or litter area. | Retained as confidence-only evidence; it cannot replace a conflicting model result. |
| `explicit_assembly_action` | Assemble/build/put-together phrasing, excluding transport and explicit assembly negation. | Construction or a secondary assembly clause. | Retained as an authoritative action boundary after negation handling. |
| `explicit_event_context` | Event/gathering nouns plus setup/service/guest-count language. | Ordinary family meals or generic help with timing. | Retained, agreement/margin gated and backed by an independent event semantic guard. |
| `explicit_pet_care_action` | Pet noun plus walk/feed/watch/sit/care action. | Cleaning around pets. | Retained as authoritative primary-intent evidence; pure environmental cleaning remains cleaning. |

## Removal conclusion

The retained architecture uses named match reasons, but only ten direct action/target boundaries can change a category. The rest require model agreement, sufficient margin, or a narrowly defined fallback from a raw category that the user explicitly excluded. On the final 1,000-case development corpus, model-only inference at threshold 0.50 emits 636 correct cases; the gated production policy emits 794 correct cases, with zero wrong emissions in both configurations. A full override deletion would therefore add 158 abstentions. The next blind set should probe the listed false-positive surfaces and determine whether any confidence-only rules remain redundant outside development data.

## Repair-pass audit on the consumed 1,000-case development corpus

The original one-shot evaluation attributed 28 dangerous emissions causally to overrides. After semantic repair and retraining, the final curated development run records zero wrong emissions and therefore zero override-caused errors.

- `explicit_bring_task_object` now requires source/destination transport language and rejects provider tools, equipment, materials, supplies, paint, parts, and vehicles. Disabling it has no effect on the curated 1,000 cases, but validation150 requires it for two explicit object-to-destination requests.
- `pet_related_cleaning` is confidence-only and cannot override direct feed/walk/watch/sit/check/care actions. Disabling it has no effect on the curated corpus.
- `explicit_pet_care_action` is authoritative for direct animal-care actions and resolves incidental litter, cage, bowl, and paw cleanup as pet care.
- `explicit_plumbing_request`, `explicit_automotive_component`, and `explicit_electrical_request` use direct action/target or target/fault grammar. Incidental sinks, toilets, panels, outlets, fans, cars, and loose car parts no longer qualify by object presence alone.
- `explicit_home_damage_assessment` is low-margin agreement evidence only. It recovered 13 correct home-services emissions and cannot replace another raw category.
- `explicit_handyman_surface_repair`, `explicit_cleaning_request`, `explicit_home_damage_assessment`, and `explicit_leading_household_move` can replace a raw top category only when that top category is explicitly excluded in the text.
- `explicit_wall_mounting_request` follows the normalized taxonomy: mounting TVs, mirrors, shelves, bookshelves, or cabinets is assembly. Towel bars/rails and robe/coat hooks are handyman hardware.
- Broad painting authority was removed. Ordinary painting requests are low-margin agreement evidence; the narrower patch-and-paint boundary remains authoritative.
- Direct electrical authority was briefly removed, but the experiment lost three unambiguous outlet-service cases and was reverted.

The final threshold remains 0.50. At 0.45 the final policy recovered three development cases with no errors; at 0.40 wrong emissions returned. The retained buffer reflects the priority placed on avoiding a wrong questionnaire.
