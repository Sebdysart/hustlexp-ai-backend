import { getQuestionsForIntake } from './definitions.js';
import type { IntakeAnswer, IntakeAnswers, TaskCategory } from './types.js';

interface Candidate { key: string; value: IntakeAnswer; confidence: number; evidence: string; }
export interface IntakePrefillResult { answers: IntakeAnswers; evidence: Array<{ key: string; value: IntakeAnswer; confidence: number; evidence: string }>; }
const THRESHOLD = 0.88;
const numberWords: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const normalize = (value: string) => value.toLowerCase().replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
function numberBefore(text: string, nouns: readonly string[]) { const n='(\\d+|'+Object.keys(numberWords).join('|')+')'; const re=new RegExp(`\\b${n}\\s+(?:\\w+\\s+){0,2}(?:${nouns.join('|')})\\b`,'i'); const m=text.match(re); if(!m)return null; const value=/^\d+$/.test(m[1])?Number(m[1]):numberWords[m[1].toLowerCase()]; return Number.isFinite(value)?{value,evidence:m[0]}:null; }
function add(target: Candidate[], candidate: Candidate) { const i=target.findIndex((item)=>item.key===candidate.key); if(i<0)target.push(candidate); else if(candidate.confidence>target[i].confidence)target[i]=candidate; }
function extract(text: string): Candidate[] {
  const out: Candidate[] = [];
  if(/\b(?:upstairs|downstairs|stairs|staircase)\b/i.test(text)) add(out,{key:'stairs',value:true,confidence:.97,evidence:'Explicit stair reference'});
  if(/\b(?:no stairs|ground floor|ground-level|ground level)\b/i.test(text)) add(out,{key:'stairs',value:false,confidence:.96,evidence:'Explicit no-stairs reference'});
  if(/\b(?:mount|mounted|mounting|attach(?:ed)? to (?:the )?wall|wall-mounted)\b/i.test(text)) add(out,{key:'wall_mounting',value:true,confidence:.97,evidence:'Explicit wall mounting reference'});
  if(/\b(?:heavy|very heavy|fragile|delicate|breakable)\b/i.test(text)) { add(out,{key:'heavy_or_fragile',value:true,confidence:.94,evidence:'Explicit heavy/fragile description'}); add(out,{key:'large_items',value:true,confidence:.89,evidence:'Explicit heavy item description'}); }
  const pet = text.match(/\b(dog|dogs|puppy|cat|cats|kitten|bird|parrot|fish|rabbit|bunny)\b/i); if(pet) add(out,{key:'pet_type',value:pet[1].toLowerCase().startsWith('dog')||pet[1].toLowerCase().startsWith('pupp')?'dog':pet[1].toLowerCase().startsWith('cat')||pet[1].toLowerCase().startsWith('kit')?'cat':pet[1].toLowerCase(),confidence:.97,evidence:'Explicit pet reference'});
  const petCount=numberBefore(text,['dog','dogs','puppy','puppies','cat','cats','bird','birds','parrot','parrots','pet','pets']); if(petCount)add(out,{key:'pet_count',value:petCount.value,confidence:.98,evidence:petCount.evidence});
  const care:string[]=[]; if(/\b(?:walk|walking)\b/i.test(text))care.push('walking'); if(/\b(?:feed|feeding)\b/i.test(text))care.push('feeding'); if(/\b(?:pet sit|pet sitting|watch my|watch the|look after|care for)\b/i.test(text))care.push('sitting'); if(/\b(?:transport|take .* to the vet|bring .* to the vet)\b/i.test(text))care.push('transport'); if(care.length)add(out,{key:'care_type',value:[...new Set(care)],confidence:.96,evidence:'Explicit pet-care action'});
  const guests=numberBefore(text,['guest','guests','people','attendees']); if(guests)add(out,{key:'guest_count',value:guests.value,confidence:.98,evidence:guests.evidence});
  const rooms=numberBefore(text,['room','rooms','bedroom','bedrooms']); if(rooms)add(out,{key:'room_count',value:rooms.value,confidence:.95,evidence:rooms.evidence});
  const assembly=numberBefore(text,['chair','chairs','desk','desks','table','tables','cabinet','cabinets','shelf','shelves','bed','beds','item','items']); if(assembly)add(out,{key:'assembly_count',value:assembly.value,confidence:.90,evidence:assembly.evidence});
  const moving=numberBefore(text,['box','boxes','item','items','bag','bags','piece','pieces']); if(moving)add(out,{key:'item_count',value:moving.value,confidence:.94,evidence:moving.evidence});
  if(/\b(cargo van|moving van|box truck|pickup truck|truck|van)\b/i.test(text))add(out,{key:'vehicle_size',value:'cargo_vehicle',confidence:.97,evidence:'Explicit cargo vehicle reference'}); else if(/\b(suv|sport utility vehicle)\b/i.test(text))add(out,{key:'vehicle_size',value:'suv',confidence:.98,evidence:'Explicit SUV reference'}); else if(/\b(car|sedan|hatchback)\b/i.test(text))add(out,{key:'vehicle_size',value:'car',confidence:.97,evidence:'Explicit car reference'});
  if(/\bupstairs\b/i.test(text))add(out,{key:'access_restrictions',value:'The task involves carrying or accessing items upstairs.',confidence:.96,evidence:'upstairs'}); else if(/\bdownstairs\b/i.test(text))add(out,{key:'access_restrictions',value:'The task involves carrying or accessing items downstairs.',confidence:.96,evidence:'downstairs'});
  return out;
}
export function extractIntakePrefill(raw: string, primaryCategory: TaskCategory, secondaryIntents: readonly TaskCategory[] = []): IntakePrefillResult { const allowed=new Set(getQuestionsForIntake(primaryCategory,secondaryIntents).map((question)=>question.key)); const accepted=extract(normalize(raw)).filter((candidate)=>candidate.confidence>=THRESHOLD&&allowed.has(candidate.key)); const answers:IntakeAnswers={}; accepted.forEach((candidate)=>{answers[candidate.key]=candidate.value;}); return {answers,evidence:accepted}; }
