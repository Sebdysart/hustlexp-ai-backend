# HustleXP Classifier Blind Holdout v3

One-shot blind evaluation dataset. Do not inspect examples before the run, do not train on it, and do not rerun it while tuning.

Total cases: 1600
Exact duplicate raw inputs: 0

Approved taxonomy:
- Internal carrying/floor-room relocation => moving.
- External source/destination/courier transport => delivery.
- Wall mounting mirrors/shelves/bookshelves/cabinets/TV brackets/coat racks => assembly.
- Repair existing mounted hardware and towel/robe/coat hooks => handyman.
- 'bring' alone does not establish delivery.
- Wrong emitted category is worse than safe abstention.

Category counts:
```json
{
  "ABSTAIN": 70,
  "assembly": 120,
  "auto": 94,
  "cleaning": 133,
  "delivery": 134,
  "electrical": 115,
  "events": 101,
  "handyman": 179,
  "home_services": 105,
  "moving": 125,
  "painting": 118,
  "pet_care": 100,
  "plumbing": 109,
  "yard": 97
}
```

Group counts:
```json
{
  "assembly_handyman": 40,
  "cleaning_home": 20,
  "conversational_extra": 409,
  "core_assembly": 45,
  "core_auto": 45,
  "core_cleaning": 46,
  "core_delivery": 44,
  "core_electrical": 47,
  "core_events": 48,
  "core_handyman": 45,
  "core_home_services": 46,
  "core_moving": 46,
  "core_painting": 44,
  "core_pet_care": 42,
  "core_plumbing": 40,
  "core_yard": 47,
  "events_vague": 20,
  "handyman_electrical": 40,
  "handyman_painting": 20,
  "handyman_plumbing": 40,
  "moving_delivery": 60,
  "multi_intent": 36,
  "noisy_short": 130,
  "override_traps": 120,
  "pet_clean": 20,
  "vague": 60
}
```
