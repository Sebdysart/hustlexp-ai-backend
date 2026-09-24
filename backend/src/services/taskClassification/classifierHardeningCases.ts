import type { ServiceTaskCategory } from './types.js';

export interface ClassifierHardeningCase {
  id: string;
  group: string;
  input: string;
  expectedCategory: ServiceTaskCategory | null;
}

interface Seed {
  text: string;
  expectedCategory: ServiceTaskCategory | null;
}

const prefixes = [
  '',
  'Please ',
  'Could somebody ',
  'I need a person to ',
  'Looking for help to ',
  'When possible, ',
  'The main task is to ',
  'At my place, ',
  'This week, ',
  'Would you ',
  'Need a pro to ',
  'Quick request: ',
] as const;

const suffixes = [
  '.',
  ' today.',
  ' this weekend.',
  '; that is the main task.',
  ' if possible.',
  ' before noon.',
  ' when available.',
  '; nothing else is requested.',
] as const;

function sentence(prefix: string, seed: string, suffix: string): string {
  const body = prefix ? `${prefix}${seed}` : `${seed[0]?.toUpperCase() ?? ''}${seed.slice(1)}`;
  return `${body.replace(/[.!?;]+$/u, '')}${suffix}`.replace(/\s+/gu, ' ').trim();
}

function expand(group: string, count: number, seeds: readonly Seed[]): ClassifierHardeningCase[] {
  const candidates: ClassifierHardeningCase[] = [];
  const seen = new Set<string>();
  for (const seed of seeds) {
    for (const prefix of prefixes) {
      for (const suffix of suffixes) {
        const input = sentence(prefix, seed.text, suffix);
        if (seen.has(input)) continue;
        seen.add(input);
        candidates.push({
          id: `${group}_${String(candidates.length + 1).padStart(4, '0')}`,
          group,
          input,
          expectedCategory: seed.expectedCategory,
        });
        if (candidates.length === count) return candidates;
      }
    }
  }
  throw new Error(`Insufficient unique seeds for ${group}: requested ${count}, built ${candidates.length}`);
}

const groups = [
  expand('generic_assistance', 240, [
    { text: 'mow the narrow lawn behind the garage', expectedCategory: 'yard' },
    { text: 'pull weeds from the raised garden beds', expectedCategory: 'yard' },
    { text: 'put the flat-pack hall table together', expectedCategory: 'assembly' },
    { text: 'mount a framed print on the plaster wall', expectedCategory: 'assembly' },
    { text: 'change the oil in my compact hatchback', expectedCategory: 'auto' },
    { text: 'check the warped ceiling after rainwater came through', expectedCategory: 'home_services' },
    { text: 'assess a soft patch beside the upstairs window', expectedCategory: 'home_services' },
    { text: 'clear the blocked utility-room drain', expectedCategory: 'plumbing' },
    { text: 'check weak pressure at the shower', expectedCategory: 'plumbing' },
    { text: 'watch my puppy during the afternoon', expectedCategory: 'pet_care' },
    { text: 'refill the rabbit food and water', expectedCategory: 'pet_care' },
    { text: 'apply two coats to the hallway wall', expectedCategory: 'painting' },
    { text: 'unload our furniture from the moving van', expectedCategory: 'moving' },
    { text: 'set up tables for thirty reception guests', expectedCategory: 'events' },
    { text: 'serve drinks at the retirement gathering', expectedCategory: 'events' },
    { text: 'vacuum the office carpets', expectedCategory: 'cleaning' },
    { text: 'replace the dead socket in the kitchen', expectedCategory: 'electrical' },
    { text: 'repair the sticking pantry-door track', expectedCategory: 'handyman' },
  ]),
  expand('target_binding', 240, [
    { text: 'fix the outlet beside the oak cabinet', expectedCategory: 'electrical' },
    { text: 'replace the switch above the floating shelf', expectedCategory: 'electrical' },
    { text: 'repair the cabinet below the working socket', expectedCategory: 'handyman' },
    { text: 'tighten the cupboard hinge near the breaker box', expectedCategory: 'handyman' },
    { text: 'mend the drywall around the functioning light switch', expectedCategory: 'handyman' },
    { text: 'repair the drain pipe behind the vanity cabinet', expectedCategory: 'plumbing' },
    { text: 'replace the leaking faucet beside the soap cabinet', expectedCategory: 'plumbing' },
    { text: 'fix the drawer beneath the kitchen sink', expectedCategory: 'handyman' },
    { text: 'wash the sink surface beside the medicine cabinet', expectedCategory: 'cleaning' },
    { text: 'scrub the wall around the outlet without touching it', expectedCategory: 'cleaning' },
    { text: 'paint the plaster behind the electrical panel', expectedCategory: 'painting' },
    { text: 'inspect the swollen wall beside the shower enclosure', expectedCategory: 'home_services' },
    { text: 'mount the mirror above the bathroom faucet', expectedCategory: 'assembly' },
    { text: 'secure the bookshelf next to the light switch', expectedCategory: 'assembly' },
  ]),
  expand('negation_exclusion', 220, [
    { text: 'patch the wall behind the basin because the plumbing is fine', expectedCategory: 'handyman' },
    { text: 'mount a coat rack above the panel and do not touch the wiring', expectedCategory: 'assembly' },
    { text: 'clean the ceiling fan blades because the fan works normally', expectedCategory: 'cleaning' },
    { text: 'repair the plaster near the faucet without plumbing work', expectedCategory: 'handyman' },
    { text: 'paint around the breaker box while leaving it alone', expectedCategory: 'painting' },
    { text: 'wash the vehicle interior with no mechanical service', expectedCategory: 'cleaning' },
    { text: 'clean pet fur from the rug without animal care', expectedCategory: 'cleaning' },
    { text: 'patch two nail holes and leave the surface unpainted', expectedCategory: 'handyman' },
    { text: 'replace the dead outlet even though the nearby cabinet is fine', expectedCategory: 'electrical' },
    { text: 'repair the leaking pipe although the wall needs no work', expectedCategory: 'plumbing' },
    { text: 'feed the cat but do not clean the room', expectedCategory: 'pet_care' },
    { text: 'inspect the damp ceiling without painting it', expectedCategory: 'home_services' },
  ]),
  expand('pronoun_coreference', 180, [
    { text: 'clean the room fan blades; it runs normally', expectedCategory: 'cleaning' },
    { text: 'wipe around the outlet; it still works fine', expectedCategory: 'cleaning' },
    { text: 'repair the cabinet beside the fan; it works properly', expectedCategory: 'handyman' },
    { text: 'patch the wall behind the tap; it is not leaking', expectedCategory: 'handyman' },
    { text: 'paint around the fuse panel; it is functioning normally', expectedCategory: 'painting' },
    { text: 'replace the ceiling fan; it no longer turns on', expectedCategory: 'electrical' },
    { text: 'fix the faucet; it keeps dripping', expectedCategory: 'plumbing' },
    { text: 'clean the dog bed; it belongs to my pet', expectedCategory: 'cleaning' },
    { text: 'walk the dog; it needs exercise', expectedCategory: 'pet_care' },
    { text: 'inspect the window frame; it feels swollen after rain', expectedCategory: 'home_services' },
  ]),
  expand('moving_delivery', 180, [
    { text: 'pick the carton up and carry it to the bedroom', expectedCategory: 'moving' },
    { text: 'bring the dresser down from the upper floor', expectedCategory: 'moving' },
    { text: 'move the sofa from the den into the lounge', expectedCategory: 'moving' },
    { text: 'load our boxes into the moving truck', expectedCategory: 'moving' },
    { text: 'collect the desk from the seller and deliver it home', expectedCategory: 'delivery' },
    { text: 'fetch the parcel at the depot and drop it at my office', expectedCategory: 'delivery' },
    { text: 'courier the signed envelope to the client address', expectedCategory: 'delivery' },
    { text: 'transport the purchased chair from the shop to my flat', expectedCategory: 'delivery' },
    { text: 'bring a boxed television', expectedCategory: null },
    { text: 'pick up the container', expectedCategory: null },
  ]),
  expand('handyman_electrical', 160, [
    { text: 'replace the dead receptacle beside the bookcase', expectedCategory: 'electrical' },
    { text: 'rewire the room fan above the damaged ceiling', expectedCategory: 'electrical' },
    { text: 'repair the wooden trim next to the live outlet', expectedCategory: 'handyman' },
    { text: 'patch the drywall beneath the working switch', expectedCategory: 'handyman' },
    { text: 'tighten the cabinet latch near the fuse panel', expectedCategory: 'handyman' },
    { text: 'install a coat hook next to the doorbell', expectedCategory: 'handyman' },
    { text: 'replace the breaker inside the electrical panel', expectedCategory: 'electrical' },
    { text: 'fix the ceiling around the fan motor while it runs fine', expectedCategory: 'handyman' },
  ]),
  expand('handyman_plumbing', 160, [
    { text: 'repair the pipe under the washbasin', expectedCategory: 'plumbing' },
    { text: 'clear the blocked shower drain', expectedCategory: 'plumbing' },
    { text: 'mend the cupboard door below the sink', expectedCategory: 'handyman' },
    { text: 'patch the plaster beside the bathtub', expectedCategory: 'handyman' },
    { text: 'replace the dripping mixer tap', expectedCategory: 'plumbing' },
    { text: 'tighten the vanity hinge next to the faucet', expectedCategory: 'handyman' },
    { text: 'inspect the swollen drywall behind the toilet', expectedCategory: 'home_services' },
    { text: 'wash the basin and surrounding tile', expectedCategory: 'cleaning' },
  ]),
  expand('assembly_handyman', 140, [
    { text: 'assemble the boxed wardrobe', expectedCategory: 'assembly' },
    { text: 'anchor the finished bookcase to masonry', expectedCategory: 'assembly' },
    { text: 'hang a hallway mirror on drywall', expectedCategory: 'assembly' },
    { text: 'mount a cabinet on the utility-room wall', expectedCategory: 'assembly' },
    { text: 'attach a coat rack to plaster', expectedCategory: 'assembly' },
    { text: 'repair the loose bracket supporting a shelf', expectedCategory: 'handyman' },
    { text: 'fix the door on an installed wall cabinet', expectedCategory: 'handyman' },
    { text: 'install a robe hook beside the closet', expectedCategory: 'handyman' },
  ]),
  expand('cleaning_home', 140, [
    { text: 'inspect the soft ceiling after water intrusion', expectedCategory: 'home_services' },
    { text: 'assess a spreading moisture stain around the skylight', expectedCategory: 'home_services' },
    { text: 'determine why the window surround is swollen', expectedCategory: 'home_services' },
    { text: 'vacuum dust from the stained wall surface', expectedCategory: 'cleaning' },
    { text: 'wash old marks from the ceiling', expectedCategory: 'cleaning' },
    { text: 'scrub mildew residue from the bathroom tile', expectedCategory: 'cleaning' },
    { text: 'patch a known small hole in drywall', expectedCategory: 'handyman' },
  ]),
  expand('pet_cleaning', 140, [
    { text: 'feed the rabbit and empty its cage tray', expectedCategory: 'pet_care' },
    { text: 'walk the puppy and wipe its muddy paws', expectedCategory: 'pet_care' },
    { text: 'check on the cat and scoop its litter', expectedCategory: 'pet_care' },
    { text: 'remove cat fur from the bedroom carpet', expectedCategory: 'cleaning' },
    { text: 'scrub dried litter from the utility floor', expectedCategory: 'cleaning' },
    { text: 'wash muddy paw prints from the entryway', expectedCategory: 'cleaning' },
    { text: 'clean the room where the pet crate sits', expectedCategory: 'cleaning' },
  ]),
  expand('events_private', 140, [
    { text: 'set up banquet tables for eighty attendees', expectedCategory: 'events' },
    { text: 'serve guests during the wedding reception', expectedCategory: 'events' },
    { text: 'decorate the venue for a retirement gathering', expectedCategory: 'events' },
    { text: 'handle teardown after the charity gala', expectedCategory: 'events' },
    { text: 'have supper with my partner at home', expectedCategory: null },
    { text: 'make dinner for my immediate family', expectedCategory: null },
    { text: 'celebrate our anniversary privately', expectedCategory: null },
  ]),
  expand('auto_indirect', 120, [
    { text: 'the sedan grinds whenever I press the brake pedal', expectedCategory: 'auto' },
    { text: 'my hatchback cranks slowly on cold mornings', expectedCategory: 'auto' },
    { text: 'the steering wheel shakes at highway speed', expectedCategory: 'auto' },
    { text: 'a warning light appeared on the dashboard', expectedCategory: 'auto' },
    { text: 'the transmission hesitates before changing gears', expectedCategory: 'auto' },
    { text: 'the rear wiper leaves the glass streaked', expectedCategory: 'auto' },
  ]),
  expand('multi_intent', 120, [
    { text: 'replace the leaking tap first and then tighten the cupboard hinge', expectedCategory: 'plumbing' },
    { text: 'patch the wall as the main job and repaint it only if time allows', expectedCategory: 'handyman' },
    { text: 'install the outlet first; afterward fill the old screw holes', expectedCategory: 'electrical' },
    { text: 'clean the kitchen first and move one chair afterward', expectedCategory: 'cleaning' },
    { text: 'carry the wardrobe upstairs before assembling the nightstand', expectedCategory: 'moving' },
    { text: 'mount the mirror first and touch up paint around it later', expectedCategory: 'assembly' },
  ]),
  expand('vague', 120, [
    { text: 'help with something at my place', expectedCategory: null },
    { text: 'send someone for a short job', expectedCategory: null },
    { text: 'need a capable person tomorrow', expectedCategory: null },
    { text: 'there is a task that needs doing', expectedCategory: null },
    { text: 'looking for general assistance nearby', expectedCategory: null },
    { text: 'can somebody stop by later', expectedCategory: null },
  ]),
  expand('noisy_mobile', 120, [
    { text: 'mow bak lawn pls', expectedCategory: 'yard' },
    { text: 'fix leaky tap asap', expectedCategory: 'plumbing' },
    { text: 'outlet ded need repair', expectedCategory: 'electrical' },
    { text: 'carry boxs upstairs 2nite', expectedCategory: 'moving' },
    { text: 'assemble wardrob tmrw', expectedCategory: 'assembly' },
    { text: 'vacum pet hair frm rug', expectedCategory: 'cleaning' },
    { text: 'car wont crank chk pls', expectedCategory: 'auto' },
    { text: 'mount miror on wall', expectedCategory: 'assembly' },
  ]),
] as const;

export const classifierHardeningCases: ClassifierHardeningCase[] = groups.flat();

const duplicateInputs = classifierHardeningCases.length - new Set(classifierHardeningCases.map(({ input }) => input)).size;
if (duplicateInputs !== 0) throw new Error(`Hardening corpus contains ${duplicateInputs} duplicate inputs.`);
