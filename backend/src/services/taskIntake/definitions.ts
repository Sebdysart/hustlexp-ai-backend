import type { IntakeQuestion, TaskCategory } from './types.js';
export const U:IntakeQuestion[]=[
 {key:'access_restrictions',label:'Are there any access restrictions the provider should know about?',kind:'text',importance:'recommended'},
 {key:'special_constraints',label:'Is there anything else that could make this task harder or affect the price?',kind:'text',importance:'recommended'},
];
const q=(key:string,label:string,kind:IntakeQuestion['kind']='text',importance:IntakeQuestion['importance']='required',conditions?:IntakeQuestion['conditions']):IntakeQuestion=>({key,label,kind,importance,conditions});
export const B:Record<TaskCategory,IntakeQuestion[]>={
 yard:[q('yard_size','About how large is the area that needs work?','select'),q('debris','Should the provider haul away the debris?','yesno'),q('debris_type','What kind of debris needs to be removed?','multiselect','required',[{key:'debris',operator:'equals',value:true}]),q('equipment_provided','Will you provide the required yard equipment?','yesno')],
 cleaning:[q('property_type','What type of property is this?','select'),q('room_count','Approximately how many rooms need cleaning?','number'),q('cleaning_type','What kind of cleaning is needed?','select'),q('supplies_provided','Will cleaning supplies and equipment be provided?','yesno')],
 moving:[q('item_count','Approximately how many items need to be moved?','number'),q('stairs','Are there stairs involved?','yesno'),q('stair_flights','How many flights of stairs are involved?','number','required',[{key:'stairs',operator:'equals',value:true}]),q('large_items','Are any items especially large or heavy?','yesno'),q('large_item_details','What large or heavy items are involved?','text','required',[{key:'large_items',operator:'equals',value:true}]),q('vehicle_required','Will the provider need to supply a vehicle?','yesno')],
 assembly:[q('assembly_type','What are you assembling?'),q('assembly_count','How many items need to be assembled?','number'),q('wall_mounting','Does anything need to be mounted to a wall?','yesno'),q('wall_type','What type of wall will the item be mounted to?','select','recommended',[{key:'wall_mounting',operator:'equals',value:true}])],
 delivery:[q('vehicle_size','What vehicle size does this need?','select'),q('delivery_item','What is being delivered?'),q('heavy_or_fragile','Is the item especially heavy, fragile, or difficult to handle?','yesno')],
 handyman:[q('work_type','What repair or handyman work is needed?'),q('materials_provided','Will the required materials or replacement parts be provided?','yesno'),q('special_tools','Does the job appear to require specialized tools?','yesno')],
 home_services:[q('service_type','What home service is needed?'),q('affected_area','What area of the property is affected?'),q('existing_damage','Is there existing damage or anything the provider should inspect first?','yesno'),q('damage_details','Describe the existing damage or issue.','text','recommended',[{key:'existing_damage',operator:'equals',value:true}])],
 auto:[q('vehicle_details','What vehicle is this for?'),q('auto_service_type','What work does the vehicle need?'),q('vehicle_drivable','Is the vehicle currently drivable?','yesno'),q('parts_provided','Are the required parts already available?','yesno')],
 events:[q('event_type','What kind of event is this?'),q('guest_count','Approximately how many people will attend?','number'),q('event_help_type','What help do you need for the event?','multiselect')],
 pet_care:[q('pet_type','What type of pet needs care?'),q('pet_count','How many pets are involved?','number'),q('care_type','What type of care is needed?','multiselect'),q('special_instructions','Are there any behavioral, feeding, medication, or handling instructions?','text','recommended')],
 other:[q('task_goal','What result would you like the provider to achieve?'),q('task_quantity','Approximately how much work is involved?'),q('provider_resources','Does the provider need to bring any tools, materials, or equipment?','text','recommended')],
};
function dedupeQuestions(questions:IntakeQuestion[]):IntakeQuestion[]{const seen=new Set<string>();return questions.filter((question)=>{if(seen.has(question.key))return false;seen.add(question.key);return true;});}
export function getQuestionsForIntake(primaryCategory:TaskCategory,secondaryIntents:readonly TaskCategory[]=[]):IntakeQuestion[]{const secondary=secondaryIntents.filter((category,index,all)=>category!==primaryCategory&&category!=='other'&&all.indexOf(category)===index);return dedupeQuestions([...B[primaryCategory],...secondary.flatMap((category)=>B[category]),...U]);}
export function getQuestionsForCategory(category:TaskCategory):IntakeQuestion[]{return getQuestionsForIntake(category,[])}
export const TASK_CATEGORIES=Object.freeze(['yard','cleaning','moving','assembly','delivery','handyman','home_services','auto','events','pet_care','other'] as const);


