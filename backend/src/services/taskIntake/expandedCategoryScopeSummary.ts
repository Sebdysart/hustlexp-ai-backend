import type { IntakeAnswers, TaskCategory } from './types.js';

const str=(a:IntakeAnswers,k:string)=>typeof a[k]==='string'&&a[k].trim()?a[k] as string:null;
const num=(a:IntakeAnswers,k:string)=>typeof a[k]==='number'&&Number.isFinite(a[k])?a[k] as number:null;
const bool=(a:IntakeAnswers,k:string)=>typeof a[k]==='boolean'?a[k] as boolean:null;
const pretty=(v:string)=>v.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());

export function appendExpandedCategorySummary(category: TaskCategory, a: IntakeAnswers, p: string[]): void {
  if (category === 'painting') {
    const surface=str(a,'painting_surface'), area=str(a,'painting_area');
    if (surface || area) p.push(`Painting work${surface ? `: ${pretty(surface).toLowerCase()}` : ''}${area ? ` in ${area}` : ''}.`);
    if (bool(a,'paint_provided') === true) p.push('Customer will provide paint.');
    if (bool(a,'paint_provided') === false) p.push('Provider should supply paint.');
    if (bool(a,'prep_needed') === true) p.push('Preparation work is required.');
    if (bool(a,'existing_damage') === true) p.push('Existing damage affects the paint job.');
    const coats=num(a,'coat_count'); if (coats !== null) p.push(`${coats} coat${coats===1?'':'s'} requested.`);
  } else if (category === 'plumbing') {
    const fixture=str(a,'plumbing_fixture'), issue=str(a,'plumbing_issue');
    if (fixture || issue) p.push(`Plumbing work${issue ? `: ${pretty(issue).toLowerCase()}` : ''}${fixture ? ` involving a ${pretty(fixture).toLowerCase()}` : ''}.`);
    if (bool(a,'active_leak') === true) p.push('Active leak reported.');
    if (bool(a,'active_leak') === false) p.push('No active leak reported.');
    if (bool(a,'water_shutoff_available') === true) p.push('Water shutoff is available.');
    if (bool(a,'water_shutoff_available') === false) p.push('Water shutoff is not available.');
    if (bool(a,'parts_provided') === true) p.push('Customer will provide required parts.');
    if (bool(a,'parts_provided') === false) p.push('Provider should supply required parts.');
  } else if (category === 'electrical') {
    const fixture=str(a,'electrical_fixture'), issue=str(a,'electrical_issue');
    if (fixture || issue) p.push(`Electrical work${issue ? `: ${pretty(issue).toLowerCase()}` : ''}${fixture ? ` involving a ${pretty(fixture).toLowerCase()}` : ''}.`);
    if (bool(a,'power_available') === true) p.push('Power is available.');
    if (bool(a,'power_available') === false) p.push('Power is not available.');
    if (bool(a,'existing_wiring') === true) p.push('Existing wiring is available.');
    if (bool(a,'existing_wiring') === false) p.push('Existing wiring is not available.');
    if (bool(a,'parts_provided') === true) p.push('Customer will provide required parts.');
    if (bool(a,'parts_provided') === false) p.push('Provider should supply required parts.');
    if (bool(a,'panel_involved') === true) p.push('The electrical panel is involved.');
  }
}
