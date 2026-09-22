/** Canonical Stage-1 intake codes. Keep aligned with the other repository's contract.
 * Classifier semantics and intake questions do not depend on database policy.
 */
export const SERVICE_CATEGORY_CODES = [
  'yard', 'cleaning', 'moving', 'assembly', 'delivery', 'handyman',
  'home_services', 'auto', 'events', 'pet_care', 'painting', 'plumbing',
  'electrical', 'other',
] as const;
export type ServiceCategoryCode = (typeof SERVICE_CATEGORY_CODES)[number];
export const SERVICE_CATEGORY_LABELS: Record<ServiceCategoryCode, string> = {
  yard: 'Yard work', cleaning: 'Cleaning', moving: 'Moving help', assembly: 'Assembly',
  delivery: 'Pickup & delivery', handyman: 'Handyman', home_services: 'Home services',
  auto: 'Auto help', events: 'Event help', pet_care: 'Pet care', painting: 'Painting',
  plumbing: 'Plumbing', electrical: 'Electrical', other: 'General task',
};
export function isServiceCategoryCode(value: string): value is ServiceCategoryCode {
  return (SERVICE_CATEGORY_CODES as readonly string[]).includes(value);
}
