export type ConstraintFactType = 'stairs'|'stair_flights'|'no_elevator'|'elevator_available'|'narrow_access'|'floor_access'|'water_unavailable'|'power_unavailable'|'underground_garage'|'approval_required'|'time_window_restriction';
export type ConstraintFact = { type: ConstraintFactType; value: boolean|number|string; evidence:string; confidence:number };
const WORD_NUMBERS:Record<string,number>={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10}; const ORDINAL_WORDS:Record<string,number>={first:1,second:2,third:3,fourth:4,fifth:5,sixth:6,seventh:7,eighth:8,ninth:9,tenth:10};
const parseNumber = (raw: string): number | undefined => {
  const normalized = raw.toLowerCase();
  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }
  return WORD_NUMBERS[normalized] ?? ORDINAL_WORDS[normalized];
};
function addFact(facts:ConstraintFact[],fact:ConstraintFact){if(!facts.some(x=>x.type===fact.type&&x.value===fact.value))facts.push(fact);}
export function extractConstraintFacts(input:string):ConstraintFact[]{const text=input.toLowerCase(),facts:ConstraintFact[]=[];if(/\b(?:has|have|with|using)\s+(?:an?\s+|the\s+)?elevator\b/i.test(text)||/\belevator\s+(?:is\s+)?available\b/i.test(text))addFact(facts,{type:'elevator_available',value:true,confidence:.98,evidence:'Explicit elevator availability.'});const fm=text.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+flights?(?:\s+of\s+stairs?)?\b/i);if(fm){const n=parseNumber(fm[1]);if(n!==undefined){addFact(facts,{type:'stair_flights',value:n,evidence:fm[0],confidence:.99});addFact(facts,{type:'stairs',value:true,evidence:fm[0],confidence:.99});}}if(/\bupstairs\b|\bdownstairs\b|\bstaircase\b|\bstairs\b/i.test(text))addFact(facts,{type:'stairs',value:true,evidence:'stairs/upstairs/downstairs',confidence:.97});if(/\bno elevator\b|\belevator unavailable\b|\bwithout an elevator\b/i.test(text))addFact(facts,{type:'no_elevator',value:true,evidence:'no elevator',confidence:.99});const nm=text.match(/\b(?:narrow\s+(?:hallway|corridor|staircase|stairs|doorway)|(?:hallway|corridor|doorway|opening)\s+(?:is\s+)?(?:only\s+)?\d+\s*(?:inches?|in\.?|feet|ft)\s+wide)\b/i);if(nm)addFact(facts,{type:'narrow_access',value:true,evidence:nm[0],confidence:.98});const numericFloorMatch = text.match(/\b(?:(?:on\s+the\s+)?(\d+)(?:st|nd|rd|th)?\s+floor|floor\s+(\d+))\b/i);
  const wordFloorMatch = text.match(/\b(?:on\s+the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+floor\b/i);
  const floorMatch = numericFloorMatch ?? wordFloorMatch;
  if (floorMatch) {
    const floor = parseNumber(floorMatch[1] ?? floorMatch[2]);
    if (floor !== undefined) addFact(facts, { type: 'floor_access', value: floor, evidence: floorMatch[0], confidence: 0.96 });
  }
if(/\bwater\s+(?:is\s+)?(?:currently\s+)?shut\s*off\b|\bno running water\b/i.test(text))addFact(facts,{type:'water_unavailable',value:true,evidence:'water unavailable',confidence:.99});if(/\bno\s+(?:outdoor\s+)?power\s+outlet\b|\bno electricity\b|\bpower is out\b/i.test(text))addFact(facts,{type:'power_unavailable',value:true,evidence:'power unavailable',confidence:.99});if(/\bunderground garage\b/i.test(text))addFact(facts,{type:'underground_garage',value:true,evidence:'underground garage',confidence:.98});if(/\blandlord approval\b.*\b(?:required|needed|may be required|may be needed)\b/i.test(text))addFact(facts,{type:'approval_required',value:true,evidence:'landlord approval',confidence:.97});const tw=text.match(/\b(?:work\s+)?can only happen between\s+([0-9:apm.\-\s]+)\b/i);if(tw||/\bbuilding rules\b.*\b(?:between|only|hours|time)\b/i.test(text))addFact(facts,{type:'time_window_restriction',value:tw?.[1]?.trim()??'restricted by building rules',evidence:tw?.[0]??'building rules',confidence:.97});return facts;}














