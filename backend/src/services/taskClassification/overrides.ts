import {
  getExplicitlyExcludedCategories,
  hasExplicitDeliveryTransportSemantics,
  hasExplicitInternalRelocationSemantics,
} from './classificationContext.js';
import type { RawTaskClassification, ServiceTaskCategory } from './types.js';
export interface ClassificationOverride {
  category: ServiceTaskCategory;
  secondaryIntents: ServiceTaskCategory[];
  reason: string;
}
function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}
const HARDWARE_MODIFIERS =
  '(?:(?:the|a|an|my|our|this|that)\\s+)?(?:(?:bathroom|loose|broken|damaged|existing|mounted|small|new|wooden|metal|vanity)\\s+){0,3}';
function directHardwareAction(text: string, action: string, target: string): boolean {
  return new RegExp(`\\b(?:${action})\\s+${HARDWARE_MODIFIERS}(?:${target})\\b`, 'i').test(text);
}
export function findClassificationOverride(
  raw: string,
  _classification: RawTaskClassification
): ClassificationOverride | null {
  const text = normalize(raw);
  const excludedCategories = getExplicitlyExcludedCategories(text);
  const hasPetCareAction =
    /\b(?:dog|dogs|cat|cats|puppy|puppies|pet|pets|fish|parrot|rabbit|rabbits|hamster|hamsters|bird|birds)\b/.test(
      text
    ) &&
    /\b(?:walk|feed|watch|sit|look after|check on|give (?:them|it|the pet) medication|refill (?:the )?(?:food|water)|let (?:them|it|the dog|the cat) out|care for)\b/.test(
      text
    );
  if (
    !excludedCategories.has('painting') &&
    (/\b(?:patch|fill|repair)\b[^.!?]{0,35}\b(?:wall|walls|ceiling|drywall|plaster)\b[^.!?]{0,35}\b(?:paint|repaint)\b/.test(
      text
    ) ||
      /\b(?:wall|walls|ceiling|drywall|plaster)\b[^.!?]{0,35}\b(?:patch|fill|repair)\b[^.!?]{0,20}\b(?:paint|repaint)\b/.test(
        text
      ) ||
      /\b(?:patch|fill|repair)\b[^.!?]{0,35}\b(?:holes?|cracks?|damage|dents?)\b[^.!?]{0,35}\b(?:paint|repaint)\b[^.!?]{0,25}\b(?:wall|walls|ceiling|drywall|plaster)\b/.test(
        text
      ))
  )
    return { category: 'painting', secondaryIntents: [], reason: 'explicit_patch_and_paint' };
  if (
    !excludedCategories.has('electrical') &&
    (/\b(?:repair|install|replace|service|fix)\b[^.!?]{0,30}\bceiling fan\b/.test(text) ||
      /\bceiling fan\b[^.!?]{0,30}\b(?:needs?|requires?)\b[^.!?]{0,12}\b(?:repair|installation|replacement|service)\b/.test(
        text
      ))
  )
    return { category: 'electrical', secondaryIntents: [], reason: 'explicit_ceiling_fan_service' };
  if (
    !excludedCategories.has('painting') &&
    ((/\b(?:paint|painting|repaint|repainting|painter|painted)\b/.test(text) &&
      /\b(?:wall|walls|ceiling|trim|baseboard|door|fence|deck|house|room)\b/.test(text)) ||
      /\btouch\s+up\b[^.!?]{0,40}\b(?:wall|walls|ceiling|trim|baseboard|doors?|fence|deck)\b/.test(
        text
      ) ||
      /\b(?:wall|walls|room|ceiling|trim|baseboard|doors?)\b[^.!?]{0,35}\bredone\b[^.!?]{0,24}\bcolou?r\b/.test(
        text
      ))
  ) {
    const paintingIndex = text.search(/\b(?:paint|painting|repaint|repainting|painter|painted)\b/);
    const earlierFirstClassServiceIndex = text.search(
      /\b(?:repair|fix|replace|install|service)\b[^.!?]{0,30}\b(?:sink|toilet|shower|bathtub|tub|faucet|tap|pipe|piping|water heater|drain|wiring|outlet|socket|receptacle|switch|ceiling fan|breaker|electrical panel|car|vehicle|engine|brakes?|battery|tires?|wipers?|headlights?)\b/
    );
    if (earlierFirstClassServiceIndex < 0 || paintingIndex < earlierFirstClassServiceIndex)
      return { category: 'painting', secondaryIntents: [], reason: 'explicit_painting_request' };
  }
  if (
    !excludedCategories.has('painting') &&
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+coats?\b/.test(text) &&
    /\b(?:wall|walls|ceiling|trim|baseboard|door|fence|deck|house|room)\b/.test(text)
  )
    return { category: 'painting', secondaryIntents: [], reason: 'explicit_paint_coat_request' };
  if (
    !excludedCategories.has('plumbing') &&
    /\b(?:install|replace|repair|fix|service|unclog)\s+(?:the\s+|an?\s+|my\s+|our\s+)?(?:new\s+|replacement\s+)?(?:(?:kitchen|bathroom|shower)\s+)?(?:sink|basin|washbasin|toilet|shower|bathtub|tub|faucet|tap|pipe|piping|water heater|drain)\b/.test(
      text
    )
  )
    return { category: 'plumbing', secondaryIntents: [], reason: 'explicit_direct_plumbing_work' };
  if (
    !excludedCategories.has('plumbing') &&
    (/\b(?:install|replace|repair|fix|service|unclog)\s+(?:the\s+|an?\s+|my\s+|our\s+)?(?:new\s+|replacement\s+)?(?:(?:kitchen|bathroom|shower)\s+)?(?:sink|basin|washbasin|toilet|shower|bathtub|tub|faucet|tap|pipe|piping|water heater|drain)\b/.test(
      text
    ) ||
      /\b(?:sink|basin|washbasin|toilet|shower|bathtub|tub|faucet|tap|pipe|piping|water heater|drain)\b[^.!?]{0,24}\b(?:is|are|keeps?|has|have|needs?|requires?)\b[^.!?]{0,16}\b(?:leaking|dripping|clogged|blocked|repair|replacement|replacing|installation|installing|low pressure|no water)\b/.test(
        text
      ) ||
      /\b(?:leaking|dripping|clogged|blocked)\s+(?:sink|basin|washbasin|toilet|shower|bathtub|tub|faucet|tap|pipe|piping|water heater|drain)\b/.test(
        text
      ) ||
      /\b(?:plumbing|plumber)\b[^.!?]{0,20}\b(?:repair|service|help|needed|required|issue|problem)\b/.test(
        text
      ))
  )
    return { category: 'plumbing', secondaryIntents: [], reason: 'explicit_plumbing_request' };
  if (
    !excludedCategories.has('plumbing') &&
    /\b(?:low|weak)\s+(?:water\s+)?pressure\b|\bwater pressure\b[^.!?]{0,20}\b(?:low|weak)\b/.test(
      text
    )
  )
    return { category: 'plumbing', secondaryIntents: [], reason: 'explicit_water_pressure_issue' };
  if (
    !excludedCategories.has('plumbing') &&
    /\b(?:leak|leaking|drip|dripping)\b/.test(text) &&
    /\b(?:stopped|no longer|not anymore|isn't anymore|is not anymore)\b/.test(text) &&
    !/\b(?:car|vehicle|engine|oil|roof|ceiling|window|dishwasher|washing machine|appliance)\b/.test(
      text
    )
  )
    return {
      category: 'plumbing',
      secondaryIntents: [],
      reason: 'explicit_historical_plumbing_leak',
    };
  const directElectricalWork = text.match(
    /\b(?:check|diagnose|install|replace|repair|fix|service|wire|rewire)\s+(?:the\s+|an?\s+|my\s+|our\s+)?(?:(?:room|new|replacement|dead|broken|faulty|flickering|tripping)\s+){0,2}(?:light|lights|light fixture|outlet|socket|receptacle|switch|fan|ceiling fan|breaker|panel|doorbell)\b|\b(?:check|diagnose)\s+(?:the\s+|an?\s+)?breaker\b[^.!?]{0,24}\btripping\b/
  );
  const competingSurfaceWorkIndex = text.search(
    /\b(?:patch|fill|mend|repair)\s+(?:the\s+|an?\s+|my\s+|our\s+)?(?:wall|walls|drywall|plaster|ceiling|surface|cabinet|cupboard|door|hinge|bracket)\b/
  );
  if (
    !excludedCategories.has('electrical') &&
    directElectricalWork &&
    (competingSurfaceWorkIndex < 0 ||
      (directElectricalWork.index ?? Number.POSITIVE_INFINITY) <= competingSurfaceWorkIndex)
  )
    return {
      category: 'electrical',
      secondaryIntents: [],
      reason: 'explicit_direct_electrical_work',
    };
  if (
    hasExplicitInternalRelocationSemantics(text)
  )
    return {
      category: 'moving',
      secondaryIntents: [],
      reason: 'explicit_internal_relocation',
    };
  if (
    /\b(?:move|carry|relocate|take)\b/.test(text) &&
    /\b(?:boxes?|wardrobe|dresser|cabinet|couch|sofa|table|chair|chairs|desk|bed|mattress|bookcase|bookshelf|shelf|shelves|lamp|piano|furniture|stool|stools)\b/.test(
      text
    ) &&
    !/\b(?:package|parcel|shipment|delivery|address)\b/.test(text)
  ) {
    const movingIndex = text.search(/\b(?:move|carry|relocate|take)\b/);
    const competingIndex = text.search(/\b(?:assemble|clean|mount|paint|repair)\b/);
    return {
      category: 'moving',
      secondaryIntents: [],
      reason:
        competingIndex < 0 || movingIndex <= competingIndex
          ? 'explicit_leading_household_move'
          : 'explicit_household_moving_request',
    };
  }
  if (
    (/\b(?:mount|wall[ -]?mount|install|hang)\b[^.!?]{0,40}\b(?:shelf(?!\s+bracket)|shelves|bookshelf|bookcase|tv(?: bracket)?|television(?: bracket)?|mirrors?|cabinets?|coat racks?)\b/.test(
      text
    ) ||
      /\b(?:anchor|attach|secure)\b[^.!?]{0,40}\b(?:shelf(?!\s+bracket)|shelves|bookshelf|bookcase|tv(?: bracket)?|television(?: bracket)?|mirrors?|cabinets?|coat racks?)\b[^.!?]{0,30}\b(?:wall|drywall|plaster|concrete|masonry|brick|tile)\b/.test(
        text
      ) ||
      /\b(?:shelf(?!\s+bracket)|shelves|bookshelf|bookcase|tv(?: bracket)?|television(?: bracket)?|mirrors?|cabinets?|coat racks?)\b[^.!?]{0,35}\b(?:mounted|hung|hanging|anchored|attached|secured)\b[^.!?]{0,24}\b(?:wall|drywall|plaster|concrete|masonry|brick|tile)\b/.test(
        text
      )) &&
    (!/\b(?:electrical|wiring|outlet|switch|breaker|light|ceiling fan)\b/.test(text) ||
      excludedCategories.has('electrical'))
  )
    return { category: 'assembly', secondaryIntents: [], reason: 'explicit_wall_mounting_request' };
  if (
    /\brake\b/.test(text) &&
    /\b(?:blower|leaf blower)\b/.test(text) &&
    /\b(?:cleanup|clean[- ]up|leaves?|branches?|yard|lawn|outdoor)\b/.test(text)
  )
    return { category: 'yard', secondaryIntents: [], reason: 'explicit_yard_tool_cleanup' };
  if (
    /\b(?:bag|pile|trim|cut|remove|clear|collect)\b/.test(text) &&
    /\b(?:leaves?|cuttings?|branches?|clippings?|green waste|yard waste)\b/.test(text) &&
    !/\b(?:roof|gutter|chimney)\b/.test(text)
  )
    return { category: 'yard', secondaryIntents: [], reason: 'explicit_yard_debris_work' };
  if (
    /\b(?:mow|cut (?:the )?grass|trim (?:the )?(?:(?:overgrown|long|tall|untidy)\s+)?(?:hedges?|shrubs?)|pull weeds?|weed|rake leaves?)\b/.test(
      text
    ) &&
    /\b(?:yard|lawn|garden|garden beds?|backyard|front yard|hedges?|shrubs?|grass|leaves?)\b/.test(
      text
    )
  )
    return { category: 'yard', secondaryIntents: [], reason: 'explicit_yard_maintenance' };
  if (
    /\b(?:hedges?|shrubs?|bushes?)\b[^.!?]{0,60}\b(?:trim|cut)\s+(?:it|them)\s+back\b/.test(text)
  )
    return { category: 'yard', secondaryIntents: [], reason: 'explicit_yard_maintenance' };
  if (/\b(?:fix|repair|mend)\b[^.!?]{0,30}\b(?:patio\s+)?screen door\b/.test(text))
    return { category: 'handyman', secondaryIntents: [], reason: 'explicit_screen_door_repair' };
  if (
    directHardwareAction(
      text,
      'install|mount|attach|secure|tighten|fix|repair',
      'towel (?:rack|rail|bar|holder)|robe hook|coat hook'
    ) ||
    /\b(?:towel (?:rack|rail|bar|holder)|robe hook|coat hook)\b[^.!?]{0,30}\b(?:loose|needs? (?:mounting|repair|tightening|securing))\b/.test(
      text
    ) ||
    directHardwareAction(
      text,
      'fix|repair|mend',
      'vanity cabinet|cabinet|cupboard|bookcase|bookshelf|drawer runner'
    ) ||
    /\b(?:bedroom|closet|cabinet|cupboard|interior|wooden)?\s*doors?\b[^.!?]{0,30}\b(?:sticks?|sticking)\b[^.!?]{0,24}\b(?:adjust|adjusting|adjustment)\b/.test(
      text
    )
  )
    return {
      category: 'handyman',
      secondaryIntents: [],
      reason: 'explicit_handyman_hardware_work',
    };
  if (
    /\b(?:patch|fill|mend|repair)\b[^.!?]{0,30}\b(?:wall|walls|drywall|plaster|ceiling|holes?|cracks?|surface)\b/.test(
      text
    ) &&
    !/\b(?:paint|painting|repaint|repainting)\b/.test(text)
  )
    return {
      category: 'handyman',
      secondaryIntents: [],
      reason: 'explicit_handyman_surface_repair',
    };
  if (
    /\b(?:fix|repair|tighten|replace)\b[^.!?]{0,40}\b(?:fence|gates?|handrail|railing|hinge|screen door|cabinet door|closet door|shelf bracket)\b/.test(
      text
    ) &&
    !/\b(?:electrical|wiring|outlet|switch|breaker|light|ceiling fan)\b/.test(text)
  )
    return { category: 'handyman', secondaryIntents: [], reason: 'explicit_handyman_repair' };
  if (
    /\b(?:roof|chimney|(?:bathroom|attic)\s+exhaust vent|attic vent|window mechanism|garage door|patio screen door)\b/.test(
      text
    ) &&
    /\b(?:inspect|check|service|repair|replace|issue|damaged|broken|damage)\b/.test(text)
  )
    return {
      category: 'home_services',
      secondaryIntents: [],
      reason: 'explicit_home_services_domain',
    };
  if (
    /\b(?:inspect|assess|check|evaluate|investigate|look at)\b[^.!?]{0,50}\b(?:soft|swollen|damp|moisture|water damage|water stain|moisture stain|damaged|damage|cracked)\b[^.!?]{0,30}\b(?:wall|ceiling|plaster|window|skylight|surface|section|patch|baseboard|skirting|trim)\b/.test(
      text
    ) ||
    /\b(?:inspect|assess|check|evaluate|investigate|look at)\b[^.!?]{0,30}\b(?:wall|ceiling|plaster|window|surface|section|patch|baseboard|skirting|trim)\b[^.!?]{0,40}\b(?:soft|swollen|damp|moisture|water damage|water stain|damaged|damage|cracked)\b/.test(
      text
    ) ||
    /\b(?:inspect|assess|check|evaluate|investigate|look at)\b[^.!?]{0,24}\b(?:damage|damaged area|moisture damage)\b[^.!?]{0,24}\b(?:beside|near|around|behind)\b/.test(
      text
    )
  )
    return {
      category: 'home_services',
      secondaryIntents: [],
      reason: 'explicit_home_damage_assessment',
    };
  if (
    !excludedCategories.has('auto') &&
    /\b(?:transmission|wiper blades?|windshield wipers?|headlights?|taillights?|brake pads?)\b/.test(
      text
    ) &&
    /\b(?:car|vehicle|sedan|truck|auto|inspect|replace|repair)\b/.test(text)
  )
    return { category: 'auto', secondaryIntents: [], reason: 'explicit_automotive_context' };
  if (
    !excludedCategories.has('auto') &&
    /\b(?:car|vehicle|sedan|automobile)\b/.test(text) &&
    /\b(?:engine|oil leak|brakes?|battery|alternator|tires?|headlights?|taillights?|wipers?)\b/.test(
      text
    ) &&
    (/\b(?:repair|replace|change|install|service|inspect|check|diagnose|fix)\b/.test(text) ||
      /\b(?:won't start|will not start|cannot start|squealing|grinding|flat tire|dead battery|not drivable)\b/.test(
        text
      ))
  )
    return { category: 'auto', secondaryIntents: [], reason: 'explicit_automotive_component' };
  if (
    !excludedCategories.has('auto') &&
    /\b(?:car|vehicle|sedan|hatchback|suv|steering wheel|dashboard|transmission|brake pedal|rear wiper)\b/.test(
      text
    ) &&
    /\b(?:grinds?|cranks? slowly|shakes?|vibrates?|warning light|hesitates?|streaked|squeals?|won't crank|will not crank)\b/.test(
      text
    )
  )
    return { category: 'auto', secondaryIntents: [], reason: 'explicit_automotive_symptom' };
  if (
    /\b(?:clean|clean up|wash|scrub|vacuum|mop|wipe|dust)\b/.test(text) &&
    /\b(?:office|workspace|rooms?|house|apartment|floor|bathroom|kitchen|window|carpet|garage|outlet|switch|panel|fan blades?|ceiling fan blades?|sink|cabinet|surface|walls?|stains?)\b/.test(
      text
    ) &&
    !/\b(?:party|wedding|event|guests?)\b/.test(text) &&
    !hasPetCareAction
  )
    return { category: 'cleaning', secondaryIntents: [], reason: 'explicit_cleaning_request' };
  const electricalFixture =
    /\b(?:electrical|light|lights|outlet|socket|receptacle|switch|fan|ceiling fan|breaker|doorbell|electrician)\b/.test(
      text
    ) || /\b(?:electrical|breaker)\s+panel\b/.test(text);
  if (
    !excludedCategories.has('electrical') &&
    electricalFixture &&
    (/\b(?:install|replace|repair|fix|service|wire|rewire)\s+(?:the\s+|an?\s+|my\s+|our\s+)?(?:(?:room|new|replacement|dead|broken|faulty|flickering|tripping)\s+){0,2}(?:light|lights|light fixture|outlet|socket|receptacle|switch|fan|ceiling fan|breaker|panel|doorbell)\b/.test(
      text
    ) ||
      /\b(?:light|lights|light fixture|outlet|socket|receptacle|switch|fan|ceiling fan|breaker|panel|doorbell)\b[^.!?]{0,48}\b(?:stopped working|not working|dead|broken|flicker|flickering|trip|tripping|no power|needs? (?:repair|replacement|replacing|installation)|want(?:s|ed)? (?:an? new )?(?:it |one )?(?:replaced|installed)|replace it|installed)\b/.test(
        text
      ) ||
      /\b(?:light|lights|outlet|socket|switch|fan|ceiling fan|breaker|panel|doorbell)\b[^.!?]{0,40}\b(?:isn't|is not|stopped)\s+working\b/.test(
        text
      ) ||
      /\b(?:light|lights)\b[^.!?]{0,30}\b(?:keeps?\s+)?cutting\s+(?:in and out|out)\b/.test(
        text
      ) ||
      /\b(?:fan|ceiling fan)\b[^.!?]{0,35}\b(?:has power|powered)\b[^.!?]{0,24}\b(?:won't|will not)\s+(?:spin|turn)\b/.test(
        text
      ))
  )
    return { category: 'electrical', secondaryIntents: [], reason: 'explicit_electrical_request' };
  if (
    /\b(pet|dog|cat)\b/.test(text) &&
    /\b(hair|waste|litter|stain|odor|mess)\b/.test(text) &&
    /\b(clean|remove|vacuum|scrub)\b/.test(text) &&
    !hasPetCareAction
  )
    return { category: 'cleaning', secondaryIntents: [], reason: 'pet_related_cleaning' };
  if (
    !excludedCategories.has('assembly') &&
    /\b(assemble|assembled|assembly|put\b(?:\s+[\w-]+){0,5}\s+together|putting\b(?:\s+[\w-]+){0,5}\s+together|build|disassembled)\b/.test(text) &&
    !/\b(pick\s*up|pickup|deliver|delivery|transport|bring\s+(?:it|them|this|that)\s+(?:home|over|to))\b/.test(
      text
    )
  )
    return { category: 'assembly', secondaryIntents: [], reason: 'explicit_assembly_action' };
  if (hasExplicitDeliveryTransportSemantics(text)) {
    const secondary: ServiceTaskCategory[] = [];
    if (/\b(assemble|put\b(?:\s+\w+){0,3}\s+together)\b/.test(text)) secondary.push('assembly');
    if (/\b(install|mount|attach)\b/.test(text)) secondary.push('handyman');
    return {
      category: 'delivery',
      secondaryIntents: secondary,
      reason: /\b(?:pick(?:ed|ing)?\s*up|pickup|collect(?:ed|ing)?|fetch(?:ed|ing)?|retrieve(?:d|ing)?|grab(?:bed|bing)?|deliver(?:ed|ing)?|delivery|transport(?:ed|ing)?|courier(?:ed|ing)?|drop[ -]?off)\b/.test(
        text
      )
        ? 'explicit_pickup_delivery'
        : 'explicit_bring_task_object',
    };
  }
  if (
    !excludedCategories.has('events') &&
    ((/\b(party|wedding|reception|event|ceremony|celebration|gala|mixer|baby shower|bridal shower|corporate event|corporate dinner|company dinner|anniversary dinner|private dinner|banquet|reception dinner|graduation gathering|community gathering)\b/.test(
      text
    ) &&
      /\b(set\s*up|setup|tear\s*down|cleanup|clean\s*up|arrange|serve|serving|run food|clear tables?|check[ -]?in|seating|staff|staffing|decorate|bartend|buffet|guests|attendees|people|\d+)\b/.test(
        text
      )) ||
      /\b(?:hosting|host)\s+(?:some\s+)?people\b[^.!?]{0,60}\b(?:set\s*up|setup|arrange|serve|cleanup|clean\s*up|decorate)\b/.test(
        text
      )) ||
    /\b(?:corporate|company|anniversary|reception)\s+dinner\b[^.!?]{0,30}\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|guests?|people|attendees?)\b/.test(
      text
    )
  )
    return { category: 'events', secondaryIntents: [], reason: 'explicit_event_context' };
  if (hasPetCareAction || /\b(?:dog|cat|pet)\b[^.!?]{0,30}\b(?:medication|vet)\b/.test(text))
    return { category: 'pet_care', secondaryIntents: [], reason: 'explicit_pet_care_action' };
  return null;
}
