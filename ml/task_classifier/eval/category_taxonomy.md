# HustleXP task-category taxonomy

This document defines category ownership for classifier evaluation oracles. Labels follow the requested work and its operational target, rather than incidental nouns or the classifier's current prediction.

## Moving and delivery

`moving` owns lifting, carrying, loading, unloading, room-to-room relocation, movement between floors, storage moves, and household relocation. `Pick up` by itself can describe lifting and does not establish delivery.

`delivery` requires transport semantics: an external source such as a seller, store, warehouse, friend, or business; movement between locations; a courier request; an explicit dropoff or destination; or delivery of a purchased item.

Examples:

- `Pick up the couch and bring it upstairs.` -> `moving`
- `Unload the furniture from the truck into the apartment.` -> `moving`
- `Pick up the couch from the seller and bring it to my apartment.` -> `delivery`
- `Collect the package from the store and deliver it to my office.` -> `delivery`

## Assembly wall mounts and handyman hardware

`assembly` owns furniture and item assembly, assembly plus anchoring, and mounting or hanging object-type items such as shelves, floating shelves, bookshelves, mirrors, TV brackets, cabinets, and coat racks. This matches the assembly questionnaire's `wall_mounting` and `wall_type` fields.

`handyman` owns repair of existing mounted objects and hardware, including shelf brackets and installed cabinets. It also owns installation of small household hardware such as towel bars, robe hooks, and coat hooks.

Examples:

- `Assemble and anchor the bookshelf.` -> `assembly`
- `Mount a floating shelf.` -> `assembly`
- `Mount an already assembled cabinet.` -> `assembly`
- `Mount a coat rack.` -> `assembly`
- `Repair the loose shelf bracket.` -> `handyman`
- `Fix the mounted cabinet door.` -> `handyman`
- `Install a towel bar.` -> `handyman`
- `Install a coat hook.` -> `handyman`

## Bring ambiguity and provider resources

`bring` alone is insufficient for `delivery`. Without a source, destination, pickup or dropoff location, transport context, or courier intent, the classifier should request clarification.

Provider resources are not delivery objects. Requests to bring tools, equipment, supplies, ladders, paint, replacement parts, or materials remain in the category of the primary service.

Examples:

- `Bring two lamps and a vase.` -> clarification
- `Bring your drill to repair the cupboard hinge.` -> `handyman`
- `Bring the purchased desk from the showroom to my workplace.` -> `delivery`

## Oracle review rule

Evaluation labels must be justified from this taxonomy and the task semantics. A classifier prediction is never sufficient reason to relabel an oracle. Ambiguous requests should remain clarification cases until product policy supplies a category.
