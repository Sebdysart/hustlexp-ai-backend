import type { TrainingExample } from './types.js';

export const TASK_CLASSIFIER_TRAINING_DATA: TrainingExample[] = [
    // Yard
    {
      input:
        'Clean up leaves and branches from my backyard.',
      expected: 'yard',
    },
    {
      input:
        'My yard is completely overgrown and needs to be cleared.',
      expected: 'yard',
    },
    {
      input:
        'Remove three bags of garden waste and some old wood.',
      expected: 'yard',
    },
    {
      input:
        "Mow a small front lawn; I don't have a mower.",
      expected: 'yard',
    },
    {
      input:
        'Trim the bushes around the driveway.',
      expected: 'yard',
    },
    {
      input:
        'Clear weeds from about 500 sq ft of garden.',
      expected: 'yard',
    },
    {
      input:
        'Remove a fallen tree branch after a storm.',
      expected: 'yard',
    },
    {
      input:
        'Clean dog waste from the backyard.',
      expected: 'yard',
    },
    {
      input:
        'Spread mulch across several flower beds.',
      expected: 'yard',
    },
    {
      input:
        'Move a pile of gravel from the driveway to the backyard.',
      expected: 'yard',
    },
    {
      input:
        'Clean gutters on a two-story house.',
      expected: 'home_services',
    },
    {
      input:
        'Pressure wash my patio and driveway.',
      expected: 'cleaning',
    },
    {
      input:
        'I need someone to make my backyard presentable before Saturday.',
      expected: 'yard',
    },

    // Cleaning
    {
      input:
        'Deep clean my two-bedroom apartment.',
      expected: 'cleaning',
    },
    {
      input:
        'Clean my kitchen and two bathrooms only.',
      expected: 'cleaning',
    },
    {
      input:
        'Move-out cleaning for an empty 3-bedroom house.',
      expected: 'cleaning',
    },
    {
      input:
        'Clean an Airbnb after guests leave.',
      expected: 'cleaning',
    },
    {
      input:
        "My apartment hasn't been cleaned for months.",
      expected: 'cleaning',
    },
    {
      input:
        'Clean inside my refrigerator and oven.',
      expected: 'cleaning',
    },
    {
      input:
        'Remove pet hair from carpets and furniture.',
      expected: 'cleaning',
    },
    {
      input:
        'Clean windows inside and outside.',
      expected: 'cleaning',
    },
    {
      input:
        'Clean a garage full of dust and cobwebs.',
      expected: 'cleaning',
    },
    {
      input:
        'I need someone to clean after a renovation.',
      expected: 'cleaning',
    },
    {
      input:
        'Just need the floors and bathrooms cleaned.',
      expected: 'cleaning',
    },
    {
      input:
        'Clean a small office after business hours.',
      expected: 'cleaning',
    },
    {
      input:
        "My tenant left the place filthy; I don't know exactly what needs cleaning.",
      expected: 'cleaning',
    },

    // Moving
    {
      input:
        'Help me move a couch and bed to another apartment.',
      expected: 'moving',
    },
    {
      input:
        'Moving a one-bedroom apartment across town.',
      expected: 'moving',
    },
    {
      input:
        'Carry 20 boxes from my garage into a moving truck.',
      expected: 'moving',
    },
    {
      input:
        'Move a refrigerator down one flight of stairs.',
      expected: 'moving',
    },
    {
      input:
        'I have a dresser that weighs about 200 pounds.',
      expected: 'other',
    },
    {
      input:
        'Help unload a U-Haul.',
      expected: 'moving',
    },
    {
      input:
        'Move furniture between rooms in the same house.',
      expected: 'moving',
    },
    {
      input:
        'Move a piano from the first floor to a truck.',
      expected: 'moving',
    },
    {
      input:
        "I need two people to move some stuff but I don't know exactly how much yet.",
      expected: 'moving',
    },
    {
      input:
        'Pick up my belongings from a storage unit and bring them home.',
      expected: 'moving',
    },
    {
      input:
        'Move 12 boxes, a TV, desk, mattress and sofa.',
      expected: 'moving',
    },
    {
      input:
        'Help me move but I already have a truck.',
      expected: 'moving',
    },
    {
      input:
        'Move some furniture from upstairs; narrow staircase.',
      expected: 'moving',
    },

    // Assembly
    {
      input:
        'Assemble an IKEA bed frame.',
      expected: 'assembly',
    },
    {
      input:
        'Put together four dining chairs and a table.',
      expected: 'assembly',
    },
    {
      input:
        'Assemble a large wardrobe.',
      expected: 'assembly',
    },
    {
      input:
        'Build a standing desk.',
      expected: 'assembly',
    },
    {
      input:
        'Assemble a trampoline in my backyard.',
      expected: 'assembly',
    },
    {
      input:
        'Put together a barbecue grill.',
      expected: 'assembly',
    },
    {
      input:
        'Assemble a bookshelf and anchor it to the wall.',
      expected: 'assembly',
    },
    {
      input:
        'Mount a TV on drywall.',
      expected: 'handyman',
    },
    {
      input:
        'Install three floating shelves on a brick wall.',
      expected: 'handyman',
    },
    {
      input:
        "Assemble a children's playset.",
      expected: 'assembly',
    },
    {
      input:
        'I bought some furniture online and need someone to put everything together.',
      expected: 'assembly',
    },
    {
      input:
        'Disassemble my bed and assemble it again after moving.',
      expected: 'assembly',
    },

    // Delivery
    {
      input:
        'Pick up a couch from Facebook Marketplace and bring it to my house.',
      expected: 'delivery',
    },
    {
      input:
        'Deliver a dining table across town.',
      expected: 'delivery',
    },
    {
      input:
        'Pick up 15 boxes from a warehouse.',
      expected: 'delivery',
    },
    {
      input:
        'Transport a large mirror without breaking it.',
      expected: 'delivery',
    },
    {
      input:
        "Deliver a refrigerator; you'll need a truck.",
      expected: 'delivery',
    },
    {
      input:
        'Pick up a birthday cake and deliver it.',
      expected: 'delivery',
    },
    {
      input:
        'Move six bags of cement from the store to my property.',
      expected: 'delivery',
    },
    {
      input:
        'Pick up a washing machine and bring it upstairs.',
      expected: 'delivery',
    },
    {
      input:
        "Collect a package from someone's house and bring it to me.",
      expected: 'delivery',
    },
    {
      input:
        'Deliver 30 folding chairs to an event venue.',
      expected: 'delivery',
    },
    {
      input:
        'Take several bags of clothes to a donation center.',
      expected: 'delivery',
    },
    {
      input:
        'Haul an old mattress away.',
      expected: 'delivery',
    },
    {
      input:
        "I bought something but I'm not sure whether it will fit in a normal car.",
      expected: 'delivery',
    },

    // Handyman
    {
      input:
        'Fix a leaking kitchen faucet.',
      expected: 'handyman',
    },
    {
      input:
        'Repair a loose door handle.',
      expected: 'handyman',
    },
    {
      input:
        'Patch a hole in drywall.',
      expected: 'handyman',
    },
    {
      input:
        'Replace a broken door hinge.',
      expected: 'handyman',
    },
    {
      input:
        'Hang five pictures on the wall.',
      expected: 'handyman',
    },
    {
      input:
        'Install curtain rods.',
      expected: 'handyman',
    },
    {
      input:
        'Replace a damaged section of baseboard.',
      expected: 'handyman',
    },
    {
      input:
        "Fix a cabinet door that won't close.",
      expected: 'handyman',
    },
    {
      input:
        'Replace a bathroom towel rack.',
      expected: 'handyman',
    },
    {
      input:
        'Install a ceiling-mounted curtain track.',
      expected: 'handyman',
    },
    {
      input:
        'Repair a fence gate.',
      expected: 'handyman',
    },
    {
      input:
        'My bedroom door keeps scraping the floor.',
      expected: 'handyman',
    },
    {
      input:
        'Something under my sink is leaking.',
      expected: 'home_services',
    },
    {
      input:
        'I need several random small repairs around my house.',
      expected: 'handyman',
    },

    // Home services
    {
      input:
        "My dishwasher isn't draining.",
      expected: 'home_services',
    },
    {
      input:
        'My washing machine is leaking water.',
      expected: 'home_services',
    },
    {
      input:
        'The garbage disposal stopped working.',
      expected: 'home_services',
    },
    {
      input:
        'One room has water damage near the ceiling.',
      expected: 'home_services',
    },
    {
      input:
        'My bathroom exhaust fan stopped working.',
      expected: 'home_services',
    },
    {
      input:
        "There's mold-looking discoloration around a window.",
      expected: 'home_services',
    },
    {
      input:
        "My garage door isn't closing properly.",
      expected: 'home_services',
    },
    {
      input:
        'My toilet keeps running.',
      expected: 'home_services',
    },
    {
      input:
        'The kitchen sink drains extremely slowly.',
      expected: 'home_services',
    },
    {
      input:
        "There's a crack in the wall that's getting bigger.",
      expected: 'home_services',
    },
    {
      input:
        'One section of my wooden floor is damaged.',
      expected: 'home_services',
    },
    {
      input:
        "My AC seems to be running but the room isn't getting cold.",
      expected: 'home_services',
    },
    {
      input:
        "I don't know what's wrong, but there is water appearing under the bathroom floor.",
      expected: 'home_services',
    },

    // Auto
    {
      input:
        'Change the oil on my 2018 Toyota Camry.',
      expected: 'auto',
    },
    {
      input:
        'Replace my car battery.',
      expected: 'auto',
    },
    {
      input:
        "My car won't start.",
      expected: 'auto',
    },
    {
      input:
        'Replace front brake pads.',
      expected: 'auto',
    },
    {
      input:
        'Install a dashcam.',
      expected: 'auto',
    },
    {
      input:
        'Replace a flat tire.',
      expected: 'auto',
    },
    {
      input:
        'Rotate all four tires.',
      expected: 'auto',
    },
    {
      input:
        'Change the headlights on my truck.',
      expected: 'auto',
    },
    {
      input:
        'My car is making a grinding noise when I brake.',
      expected: 'auto',
    },
    {
      input:
        'Diagnose why my check-engine light is on.',
      expected: 'auto',
    },
    {
      input:
        'Replace windshield wipers.',
      expected: 'auto',
    },
    {
      input:
        'Install new speakers in my car.',
      expected: 'auto',
    },
    {
      input:
        "My vehicle doesn't run, and I need someone to look at it.",
      expected: 'auto',
    },
    {
      input:
        'I already bought the replacement alternator and need someone to install it.',
      expected: 'auto',
    },
    {
      input:
        "I need brake work but don't know what parts are required.",
      expected: 'auto',
    },

    // Events
    {
      input:
        'Help set up tables and chairs for a birthday party.',
      expected: 'events',
    },
    {
      input:
        'Clean up after a wedding reception.',
      expected: 'events',
    },
    {
      input:
        'Serve food at a party with 60 guests.',
      expected: 'events',
    },
    {
      input:
        'Help decorate a venue for a baby shower.',
      expected: 'events',
    },
    {
      input:
        'Need two people to check guests in at an event.',
      expected: 'events',
    },
    {
      input:
        'Set up tents, chairs and decorations for an outdoor party.',
      expected: 'events',
    },
    {
      input:
        'Help tear down everything after an event.',
      expected: 'events',
    },
    {
      input:
        'Bartending help for a private party.',
      expected: 'events',
    },
    {
      input:
        'Help serve dinner and clean dishes afterward.',
      expected: 'events',
    },
    {
      input:
        'Need someone to manage the buffet table.',
      expected: 'events',
    },
    {
      input:
        'Corporate event for 150 people; need setup help.',
      expected: 'events',
    },
    {
      input:
        'Backyard party, about 25 people, just need an extra pair of hands.',
      expected: 'events',
    },
    {
      input:
        "I need help with my wedding but I'm not exactly sure what jobs yet.",
      expected: 'events',
    },

    // Pet care
    {
      input:
        'Walk my dog for 30 minutes.',
      expected: 'pet_care',
    },
    {
      input:
        'Walk two large dogs twice today.',
      expected: 'pet_care',
    },
    {
      input:
        "Feed my cat while I'm out of town.",
      expected: 'pet_care',
    },
    {
      input:
        'Visit my house and check on three cats.',
      expected: 'pet_care',
    },
    {
      input:
        'Watch my dog for four hours.',
      expected: 'pet_care',
    },
    {
      input:
        "Clean my cat's litter box and refill food and water.",
      expected: 'pet_care',
    },
    {
      input:
        'Take my dog to the vet.',
      expected: 'pet_care',
    },
    {
      input:
        'Look after my puppy overnight.',
      expected: 'pet_care',
    },
    {
      input:
        "Feed my fish while I'm away.",
      expected: 'pet_care',
    },
    {
      input:
        'Walk an elderly dog that needs to move slowly.',
      expected: 'pet_care',
    },
    {
      input:
        'Watch two dogs; one needs medication at 6 PM.',
      expected: 'pet_care',
    },
    {
      input:
        'My dog is nervous around strangers.',
      expected: 'pet_care',
    },
    {
      input:
        'Pet sit for the weekend.',
      expected: 'pet_care',
    },

    // Other / general errands
    {
      input:
        'Help organize my garage.',
      expected: 'other',
    },
    {
      input:
        'Sort and pack everything in my bedroom.',
      expected: 'other',
    },
    {
      input:
        'Take photos of 50 products for my online store.',
      expected: 'other',
    },
    {
      input:
        'Put labels on 300 packages.',
      expected: 'other',
    },
    {
      input:
        'Help inventory items in my warehouse.',
      expected: 'other',
    },
    {
      input:
        'Wait at my apartment for a repair technician.',
      expected: 'other',
    },
    {
      input:
        'Stand in line and pick something up for me.',
      expected: 'other',
    },
    {
      input:
        'Help rearrange furniture before guests arrive.',
      expected: 'moving',
    },
    {
      input:
        'Remove old items from my storage room.',
      expected: 'other',
    },
    {
      input:
        'Take measurements of every room in my house.',
      expected: 'other',
    },
    {
      input:
        'Help me hang Christmas decorations.',
      expected: 'handyman',
    },
    {
      input:
        'Take down holiday lights.',
      expected: 'handyman',
    },
    {
      input:
        "Water my plants while I'm away.",
      expected: 'yard',
    },
    {
      input:
        'Help load equipment for a photo shoot.',
      expected: 'moving',
    },
    {
      input:
        'Count boxes and organize them by label.',
      expected: 'other',
    },
    {
      input:
        'Put flyers on 200 doors.',
      expected: 'other',
    },
    {
      input:
        'Help me clean and organize my workshop.',
      expected: 'cleaning',
    },
    {
      input:
        'Scan and organize a pile of documents.',
      expected: 'other',
    },
    {
      input:
        'Someone needs to be at the property to let a contractor inside.',
      expected: 'other',
    },

    // Deliberately vague
    {
      input:
        'I need help with my backyard.',
      expected: 'yard',
    },
    {
      input:
        'My house needs some work.',
      expected: 'other',
    },
    {
      input:
        'Need someone with a truck tomorrow.',
      expected: 'other',
    },
    {
      input:
        'Can someone come fix this?',
      expected: 'other',
    },
    {
      input:
        'I have a bunch of stuff that needs moving.',
      expected: 'moving',
    },
    {
      input:
        'Need help cleaning before my parents visit.',
      expected: 'cleaning',
    },
    {
      input:
        'Need someone handy for a few hours.',
      expected: 'handyman',
    },
    {
      input:
        'My car is acting weird.',
      expected: 'auto',
    },
    {
      input:
        'Need help setting things up for Saturday.',
      expected: 'other',
    },
    {
      input:
        'Looking for someone to help around the house.',
      expected: 'other',
    },
    {
      input:
        'I bought a large thing and need it brought home.',
      expected: 'delivery',
    },
    {
      input:
        "There's a mess in my garage.",
      expected: 'other',
    },
    {
      input:
        'I have about 10 things that need fixing.',
      expected: 'handyman',
    },
    {
      input:
        'Need someone ASAP.',
      expected: 'other',
    },
    {
      input:
        'Looking for two people for around three hours.',
      expected: 'other',
    },

    // Multi-intent
    {
      input:
        'Pick up my new bed, bring it upstairs and assemble it.',
      expected: 'delivery',
    },
    {
      input:
        'Move my couch and mount my TV after we get to the new apartment.',
      expected: 'moving',
    },
    {
      input:
        'Clean my backyard and haul all the debris away.',
      expected: 'yard',
    },
    {
      input:
        'Assemble a cabinet and attach it to the wall.',
      expected: 'assembly',
    },
    {
      input:
        'Pick up a refrigerator and install it.',
      expected: 'delivery',
    },
    {
      input:
        'Help set up my party and clean everything afterward.',
      expected: 'events',
    },
    {
      input:
        'Move my old washing machine outside and install the new one.',
      expected: 'home_services',
    },
    {
      input:
        'Clean my garage and take all the junk to the dump.',
      expected: 'cleaning',
    },
    {
      input:
        'Buy some shelves, deliver them and install them in my garage.',
      expected: 'handyman',
    },
    {
      input:
        'Move my furniture out of the room so the floor can be cleaned.',
      expected: 'moving',
    },
    {
      input:
        'Pick up a desk from IKEA, assemble it and remove the packaging.',
      expected: 'delivery',
    },
    {
      input:
        'Trim my trees and haul away the branches.',
      expected: 'yard',
    },

    // Scale / constraints / edge cases
    {
      input:
        'Need someone to move 1 box.',
      expected: 'moving',
    },
    {
      input:
        'Need someone to move approximately 200 boxes.',
      expected: 'moving',
    },
    {
      input:
        'Clean 12 bedrooms and 8 bathrooms.',
      expected: 'cleaning',
    },
    {
      input:
        'Assemble 25 office desks.',
      expected: 'assembly',
    },
    {
      input:
        'Deliver a 400-pound safe.',
      expected: 'delivery',
    },
    {
      input:
        'Move a sofa up five flights of stairs with no elevator.',
      expected: 'moving',
    },
    {
      input:
        'Clean a house but the water is currently shut off.',
      expected: 'cleaning',
    },
    {
      input:
        "Yard cleanup, but there's no outdoor power outlet.",
      expected: 'yard',
    },
    {
      input:
        "Mount TV but I don't know what the wall is made of.",
      expected: 'handyman',
    },
    {
      input:
        "Fix faucet; I already bought some parts but don't know if they're correct.",
      expected: 'handyman',
    },
    {
      input:
        "Car won't start and it's parked in an underground garage.",
      expected: 'auto',
    },
    {
      input:
        "Deliver a glass dining table that's extremely fragile.",
      expected: 'delivery',
    },
    {
      input:
        'Pet sit four dogs, two cats and a parrot.',
      expected: 'pet_care',
    },
    {
      input:
        'Setup event for somewhere between 50 and 200 people.',
      expected: 'events',
    },
    {
      input:
        'Move furniture but the hallway is only 30 inches wide.',
      expected: 'moving',
    },
    {
      input:
        'Need cleanup after a party; not sure how bad it will be.',
      expected: 'events',
    },
    {
      input:
        'Assemble furniture but some pieces might be missing.',
      expected: 'assembly',
    },
    {
      input:
        "Remove debris but I don't know what type of material it is.",
      expected: 'other',
    },
    {
      input:
        'Need handyman work in a rental property; landlord approval may be required.',
      expected: 'handyman',
    },
    {
      input:
        'Work can only happen between 2:00-4:00 PM because of building rules.',
      expected: 'other',
    },

    // Casual / messy language
    {
      input:
        "yo need someone to grab a couch from this dude like 15 mins away and bring it over, probably need a van cuz it's kinda huge",
      expected: 'delivery',
    },
    {
      input:
        'backyard is fucked lol bunch of leaves branches and random junk everywhere, just want all of it gone',
      expected: 'yard',
    },
    {
      input:
        'moving next week got like bed tv desk maybe 10 boxes idk, second floor rn new place has elevator',
      expected: 'moving',
    },
    {
      input:
        'something leaking below kitchen sink not sure what, got water on cabinet floor',
      expected: 'home_services',
    },
  ];
