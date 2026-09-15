import type { ServiceTaskCategory } from './types.js';

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const PLUMBING_TARGET =
  '(?:plumbing|sink|basin|washbasin|toilet|shower|bathtub|tub|faucet|tap|pipe|piping|water heater|drain)';
const ELECTRICAL_TARGET =
  '(?:electrical|wiring|outlet|socket|receptacle|switch|ceiling fan|fan|breaker|panel|doorbell|light fixture)';
const AUTO_TARGET = '(?:auto|car|vehicle|engine|brakes?|battery|tires?|wipers?|headlights?)';

function matches(text: string, source: string): boolean {
  return new RegExp(source, 'i').test(text);
}

const CONCRETE_SERVICE_ACTION =
  /\b(?:adjust|anchor|apply\s+(?:(?:a|an|the)\s+)?(?:one|two|three|four|five|first|second|third|fourth|fifth|\d+)\s+coats?|arrange|assemble|assess|bartend|bring|build|carry|change\s+(?:the\s+)?oil|check[ -]?in|check\s+on|clean|clear|collect|coordinate|courier|cut\s+(?:the\s+)?grass|decorate|deliver|diagnose|dispose|drop[ -]?off|dust|evaluate|feed|fill|fix|give\b[^.!?]{0,24}\b(?:food|water)|hang|haul|inspect|install|investigate|lift|load|look\s+(?:after|at)|mend|mount|move|mow|paint|patch|pet[ -]?sit|pick\s*up|pull\s+weeds?|put\b[^.!?]{0,32}\btogether|rake|redo|refill|relocate|remove|repair|replace|repaint|retrieve|rewire|run\s+food|scrape|scrub|secure|serve|service|set\s*up|shift|sit\s+with|take\s+apart|tear\s*down|tighten|touch\s+up|transport|trim|unclog|unload|vacuum|walk|wash|watch|weed|wipe|wire)\b/i;

const CONCRETE_STATE_OR_SYMPTOM =
  /\b(?:clogged|blocked|leaking|dripping|active\s+leak|no\s+(?:power|water)|low\s+(?:water\s+)?pressure|water\s+pressure\s+(?:is\s+)?(?:low|weak)|won't\s+(?:start|crank|spin|turn on)|will\s+not\s+(?:start|crank|spin|turn on)|(?:isn't|is not|stopped)\s+working|cuts?\s+(?:in and out|out)|dead\s+(?:outlet|battery)|(?:outlet|battery|car battery)\s+(?:is\s+)?dead|flickering|breaker\s+(?:(?:that\s+)?keeps\s+)?tripping|tripping\s+breaker|grinds?|cranks? slowly|running\s+rough|check[- ]engine\s+light|pulls?\s+to\s+one\s+side|shakes?|vibrates?|warning light|hesitates?|disassembled|soft|swollen|warped\s+(?:wall|ceiling|surface)|water[- ]damaged|moisture[- ]damaged|water\s+damage|moisture\s+damage|peeling)\b/i;
const CONCRETE_INFLECTED_SERVICE =
  /\b(?:adjusting|assembled|assembling|assessment\s+of\s+(?:damage|an?\s+damaged|interior damage)|cleaning|clean[- ]?up|feeding|giving\b[^.!?]{0,24}\b(?:food|water)|loading|mending|mounting|moving|painting|patching|putting\b[^.!?]{0,24}\btogether|redone\s+in\s+(?:a\s+)?(?:lighter|darker|different|new)\s+colou?r|relocating|repairing|replacing|serving|servicing|setting\s+up|shifting|trimming|unloading|care\s+for|event\s+(?:help|staff|setup|cleanup)|home\s+repair|pet\s+care|yard\s+cleanup|lawn\s+care|plumbing\s+help|electrical\s+help)\b/i;
const CONCRETE_HOSTED_EVENT_REQUEST =
  /\b(?:help|assistance|staff|check[ -]?in|seating)\b[^.!?]{0,40}\b(?:at|for|with)\s+(?:an?\s+)?(?:event|party|wedding|reception|ceremony|gala|banquet|mixer|shower|celebration)\b|\b(?:event|party|wedding|reception|ceremony|gala|banquet|mixer|shower|celebration|private dinner)\b[^.!?]{0,45}\b(?:\d+|guests?|attendees?|people|serving|staffing|check[ -]?in|seating)\b/i;

function hasNegatedServiceIntent(text: string, target: string): boolean {
  return (
    matches(text, `\\b(?:not asking|not looking)\\s+for\\s+(?:any\\s+)?${target}\\b`) ||
    matches(text, `\\b(?:do not|don't)\\s+need\\s+(?:any\\s+)?${target}\\b`) ||
    matches(text, `\\bno\\s+${target}\\s+(?:is\\s+)?(?:needed|required)\\b`) ||
    matches(text, `\\b${target}\\s+(?:is|are)\\s+not\\s+involved\\b`)
  );
}

/** True when normal conversational wrapper text still contains a concrete requested task. */
export function hasConcreteTaskPredicate(raw: string): boolean {
  const text = normalize(raw);
  return (
    CONCRETE_SERVICE_ACTION.test(text) ||
    CONCRETE_INFLECTED_SERVICE.test(text) ||
    CONCRETE_HOSTED_EVENT_REQUEST.test(text) ||
    CONCRETE_STATE_OR_SYMPTOM.test(text)
  );
}

/** Generic assistance is vague only when no concrete service predicate is present. */
export function isGenericAssistanceOnlyRequest(raw: string): boolean {
  const text = normalize(raw);
  return (
    /\b(?:someone|somebody|person|worker|help|assistance|something|task|job)\b/i.test(text) &&
    !hasConcreteTaskPredicate(text)
  );
}

/** Extract a leading task only when the customer explicitly marks its priority. */
export function extractExplicitPrimaryTaskClause(raw: string): string | null {
  const text = normalize(raw);
  if (!/\b(?:first|main (?:job|task)|priority|before|afterward|then|if (?:there is|there's) time)\b/.test(text))
    return null;
  const conditionalSecondary = text.replace(
    /\s+and\s+(?=[^.!?;]{0,45}\b(?:only if|if (?:there is|there's) time|if time allows)\b)[^.!?;]*/i,
    ''
  );
  const clause = conditionalSecondary
    .split(/;|\b(?:and then|afterward|then|before)\b/i)[0]
    ?.replace(/\b(?:as the main (?:job|task)|first)\b/gi, '')
    .trim();
  return clause || null;
}

function hasAffirmedDirectService(text: string, category: ServiceTaskCategory): boolean {
  const action = '(?:repair|fix|replace|install|service|work on)';
  const direct = (target: string): boolean =>
    matches(
      text,
      `(?:^|[.;!?]|\\bbut\\b|\\band\\b)\\s*(?!do not\\b|don't\\b|no need\\b)(?:please\\s+)?${action}\\s+(?:the\\s+|an?\\s+|my\\s+|our\\s+)?${target}\\b`
    ) ||
    matches(
      text,
      `${target}\\b[^.;!?]{0,24}\\b(?:still\\s+)?(?:needs?|requires?)\\s+(?:to be\\s+)?(?:repaired|fixed|replaced|installed|serviced)\\b`
    );

  if (category === 'plumbing') return direct(PLUMBING_TARGET);
  if (category === 'electrical')
    return (
      direct(ELECTRICAL_TARGET) ||
      matches(
        text,
        `${ELECTRICAL_TARGET}\\b[^.;!?]{0,35}\\b(?:but|,|;)\\s*(?:i\\s+)?(?:still\\s+)?(?:want|need|would like)?[^.;!?]{0,18}\\b(?:replace|replaced|install|installed)\\b`
      )
    );
  if (category === 'auto') return direct(AUTO_TARGET);
  if (category === 'painting')
    return matches(
      text,
      '(?:^|[.;!?]|\\bbut\\b|\\band\\b)\\s*(?!do not\\b|don\'t\\b|no need\\b)(?:please\\s+)?(?:paint|repaint)\\s+(?:the\\s+|an?\\s+|my\\s+|our\\s+)?(?:wall|walls|ceiling|trim|door|fence|deck|house|room)\\b'
    );
  if (category === 'events')
    return matches(
      text,
      '\\b(?:set up|setup|decorate|serve|bartend|staff|coordinate|clean up|cleanup)\\b[^.;!?]{0,40}\\b(?:event|party|wedding|reception|ceremony|gala|banquet)\\b'
    );
  return false;
}

function hasExplicitExclusion(text: string, category: ServiceTaskCategory): boolean {
  const intentTarget =
    category === 'assembly'
      ? '(?:assembly|assembling)'
      : category === 'painting'
        ? '(?:paint|painting|repainting)'
        : category === 'events'
          ? '(?:event|party|reception|event work|event help)'
          : category === 'plumbing'
            ? '(?:plumbing|plumbing work|plumbing help)'
            : category === 'electrical'
              ? '(?:electrical|electrical work|wiring work)'
              : category === 'auto'
                ? '(?:auto|automotive|vehicle repair|car repair)'
                : null;
  if (intentTarget && hasNegatedServiceIntent(text, intentTarget)) return true;

  if (category === 'assembly')
    return (
      matches(text, '\\b(?:do not|don\'t|no need to)\\s+(?:assemble|build|put (?:it|them|this|that) together)\\b') ||
      matches(text, '\\bno\\s+(?:assembly|assembly help)\\s+(?:is\\s+)?(?:needed|required)\\b') ||
      matches(text, '\\bassembly\\s+(?:is|was)\\s+not\\s+(?:needed|required)\\b')
    );

  if (category === 'painting')
    return (
      matches(text, '\\b(?:no|without)\\s+(?:need for\\s+)?(?:paint|painting|repainting)\\b') ||
      matches(text, '\\b(?:paint|painting|repainting)\\s+(?:is|are)\\s+not\\s+(?:needed|required)\\b') ||
      matches(text, '\\b(?:do not|don\'t)\\s+(?:paint|repaint)\\b') ||
      matches(text, '\\bleave\\b[^.;!?]{0,30}\\bunpainted\\b') ||
      matches(text, '\\b(?:paint|painting)\\b[^.;!?]{0,20}\\b(?:can be ignored|leave (?:it|that) alone|already (?:done|finished))\\b')
    );

  if (category === 'events')
    return (
      matches(text, '\\bno\\s+(?:event|party|wedding|reception)\\s+(?:help|work|service|setup|staffing)\\b') ||
      matches(text, '\\b(?:event|party|wedding|reception)\\s+(?:help|work|service|setup|staffing)\\s+(?:is|was)\\s+not\\s+(?:needed|required)\\b')
    );

  const target =
    category === 'plumbing'
      ? PLUMBING_TARGET
      : category === 'electrical'
        ? ELECTRICAL_TARGET
        : category === 'auto'
          ? AUTO_TARGET
          : null;
  if (!target) return false;

  const categoryWord =
    category === 'plumbing'
      ? '(?:plumbing|plumber)'
      : category === 'electrical'
        ? '(?:electrical|electrician|wiring)'
        : '(?:auto|automotive|car|vehicle)';
  return (
    matches(text, `\\bno\\s+${categoryWord}\\s+(?:work|repair|service|help)\\b`) ||
    matches(
      text,
      `\\b${categoryWord}\\s+(?:work|repair|service|help)\\s+(?:is|was)\\s+not\\s+(?:needed|required)\\b`
    ) ||
    matches(text, `\\b${categoryWord}\\s+(?:is|was|looks?|seems?)\\s+(?:fine|okay|ok)\\b`) ||
    matches(
      text,
      `\\b${target}\\b\\s+(?:(?:itself|themselves)\\s+)?(?:still\\s+)?(?:(?:works?|is working)(?:\\s+(?:fine|normally|properly))?|(?:runs?|is running)\\s+(?:fine|normally|properly))\\b`
    ) ||
    matches(
      text,
      `\\b${target}\\b[^.!?;]{0,60}[.!?;]\\s*(?:it|that|this|they)\\s+(?:still\\s+)?(?:works?|functions?|runs?|is working|is running)\\s+(?:fine|normally|properly)\\b`
    ) ||
    matches(text, `\\b${target}\\b[^.;!?]{0,24}\\b(?:can be ignored|leave (?:it|that) alone)\\b`) ||
    matches(
      text,
      `\\b(?:do not|don't|no need to)\\s+(?:touch|repair|fix|replace|service|work on)\\s+(?:the\\s+|an?\\s+)?${target}\\b`
    ) ||
    matches(
      text,
      `\\bwithout\\s+(?:touching|repairing|fixing|replacing|servicing)\\s+(?:(?:the|an?)\\s+)?${target}\\b`
    ) ||
    (matches(text, `\\b${target}\\b`) &&
      matches(
        text,
        `\\bwithout\\s+(?:touching|repairing|fixing|replacing|servicing)\\s+(?:it|that)\\b`
      )) ||
    matches(text, `\\b${target}\\b[^.;!?]{0,24}\\b(?:already fixed|already repaired)\\b`)
  );
}

export function getExplicitlyExcludedCategories(raw: string): ReadonlySet<ServiceTaskCategory> {
  const text = normalize(raw);
  const excluded = new Set<ServiceTaskCategory>();
  for (const category of [
    'assembly',
    'plumbing',
    'electrical',
    'painting',
    'events',
    'auto',
  ] as const) {
    if (hasExplicitExclusion(text, category) && !hasAffirmedDirectService(text, category)) {
      excluded.add(category);
    }
  }
  return excluded;
}

export function hasEventServiceSemantics(raw: string): boolean {
  const text = normalize(raw);
  if (
    /\b(?:event|party|wedding|reception|ceremony|gala|banquet|mixer|baby shower|bridal shower|corporate event|corporate dinner|company dinner|graduation gathering)\b/.test(
      text
    )
  )
    return true;

  const personalOccasion = /\b(?:anniversary dinner|celebration|private dinner|family dinner)\b/.test(
    text
  );
  const hostedOccasion =
    /\b(?:birthday|bridal shower|retirement dinner|retirement gathering|family gathering)\b/.test(
      text
    );
  const serviceEvidence =
    /\b(?:guests?|attendees?|people|setup|set up|cleanup|clean up|serve|serving|staff|staffing|check[ -]?in|seating|run food|clear tables?|decorate|decorations?|bartend|cater|buffet|venue)\b/.test(
      text
    ) || /\b\d+\s+(?:guests?|attendees?|people)\b/.test(text);
  if (
    /\b(?:hosting|host)\s+(?:some\s+)?people\b/.test(text) &&
    /\b(?:set up|setup|arrange|serve|serving|staff|cleanup|clean up|decorate)\b/.test(text)
  )
    return true;
  return (
    (personalOccasion || hostedOccasion || /\b(?:dinner|supper|meal)\b/.test(text)) &&
    serviceEvidence
  );
}

const EXTERNAL_PICKUP_SOURCE =
  /\b(?:seller|store|shop|warehouse|depot|retailer|showroom|bakery|marketplace|post office|auction house|business|friend|agent|landlord|supplier|vendor|someone(?:'s)? house|pickup (?:address|location))\b/;
const DELIVERY_DESTINATION =
  /\b(?:bring|brought|take|taking|fetch|fetched|retrieve|retrieved|collect|collected)\b[^.!?]{0,80}\b(?:over\s+)?to\s+(?:me|us|here|there)\b|\b(?:bring|brought|take|taking|fetch|fetched|retrieve|retrieved|collect|collected)\b[^.!?]{0,80}\b(?:over\s+)?to\s+(?:(?:my|our|the|a|an)\s+)?(?:(?:community|shipping|distribution|recycling)\s+)?(?:home|house|apartment|office|address|business|venue|studio|clinic|gallery|shelter|center|centre|school|hotel|airport|workplace|property|job site)\b|\b(?:bring|brought)\b[^.!?]{0,60}\b(?:home|here|over)\b/;
const PROVIDER_RESOURCE_BRING =
  /\bbring\b(?:\s+(?:your|their|the provider(?:'s)?|basic|required|own|some|all)){0,4}\s+(?:an?\s+)?(?:truck|van|car|suv|drill|ladder|mower|rake|leaf blower|tools?|materials?|supplies?|paint|replacement parts?|equipment)\b/;

export function hasExplicitDeliveryTransportSemantics(raw: string): boolean {
  const text = normalize(raw);
  if (/\b(?:deliver(?:ed|ing)?|delivery|courier(?:ed|ing)?|drop[ -]?off|transport(?:ed|ing)?)\b/.test(text))
    return true;
  if (/\bdrop(?:ped|ping)?(?:\s+(?:it|them|the item|the package))?\s+(?:at|to)\b/.test(text))
    return true;

  const pickupAction =
    /\b(?:pick(?:ed|ing)?\s*up|pickup|collect(?:ed|ing)?|fetch(?:ed|ing)?|retrieve(?:d|ing)?|grab(?:bed|bing)?)\b/.test(
      text
    );
  if (pickupAction && EXTERNAL_PICKUP_SOURCE.test(text)) return true;
  if (
    /\b(?:bring|take|carry|move|transport)\b[^.!?]{0,70}\bfrom\s+(?:my|our|the|a|an)\s+(?:house|home|office|business|shop|store|warehouse|friend|relative|sister|brother|parent)[^.!?]{0,70}\bto\s+(?:my|our|the|a|an)\s+(?:(?:client|customer|friend|relative|sister's|brother's|parent's)\s+)?(?:house|home|office|business|address|place|apartment|venue)\b/.test(
      text
    )
  )
    return true;
  if (
    /\bbring\b[^.!?]{0,60}\bfrom\s+(?:the\s+|an?\s+)?(?:seller|store|shop|warehouse|depot|retailer|market|business)\b/.test(
      text
    )
  )
    return true;
  const transportText = text.replace(PROVIDER_RESOURCE_BRING, '');
  if (DELIVERY_DESTINATION.test(transportText)) return true;

  return (
    pickupAction &&
    /\b(?:purchased|bought|online order|customer order|my order|the order|groceries)\b/.test(
      text
    )
  );
}

export function hasExplicitInternalRelocationSemantics(raw: string): boolean {
  const text = normalize(raw);
  if (hasExplicitDeliveryTransportSemantics(text)) return false;
  if (/\b(?:deliver(?:ed|ing)?|delivery|courier(?:ed|ing)?|drop[ -]?off)\b/.test(text))
    return false;
  if (EXTERNAL_PICKUP_SOURCE.test(text)) return false;

  const nonBringActionIndex = text.search(
    /\b(?:move|carry|lift|relocate|shift|load|unload|take|transport|pick\s*up|pickup)\b/
  );
  const bringActionIndex = PROVIDER_RESOURCE_BRING.test(text) ? -1 : text.search(/\bbring\b/);
  const actionIndexes = [nonBringActionIndex, bringActionIndex].filter((index) => index >= 0);
  const actionIndex = actionIndexes.length === 0 ? -1 : Math.min(...actionIndexes);
  const object =
    /\b(?:belongings|possessions|furniture|boxes?|cartons?|packages?|parcels?|wardrobe|dresser|cabinet|couch|sofa|table|chairs?|desk|bed|mattress|bookcase|bookshelf|shelves?|lamp|television|tv|piano|stools?|appliance|refrigerator|washer|dryer|laundry basket)\b/.test(
      text
    );
  const internalDestination =
    /\b(?:upstairs|downstairs|upper floor|lower floor|ground floor|second floor|third floor|basement|cellar|garage|hallway|bedroom|guest room|living room|dining room|study|utility room|laundry room|next room|another room|other room|across the room|across the house|within the (?:house|apartment|building)|inside the (?:house|apartment|building)|moving (?:truck|van)|storage unit|one flight|two flights|three flights|\d+ flights?)\b/.test(
      text
    );
  const competingServiceIndex = text.search(
    /\b(?:assemble|build|put\b[^.!?]{0,24}\btogether|mount|hang|install|clean|paint|repair|fix)\b/
  );

  return (
    actionIndex >= 0 &&
    object &&
    internalDestination &&
    (competingServiceIndex < 0 || actionIndex <= competingServiceIndex)
  );
}
