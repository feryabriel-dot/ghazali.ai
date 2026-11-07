export const APPROVED_LANGUAGES = [
  'Bahasa Indonesia',
  'Bahasa Melayu Malaysia',
  'Bahasa Jawa',
  'Bahasa Madura',
  'English (US)',
] as const;

export type ApprovedLanguage = (typeof APPROVED_LANGUAGES)[number];

export function isApprovedLanguage(value: unknown): value is ApprovedLanguage {
  return typeof value === 'string' && APPROVED_LANGUAGES.includes(value as ApprovedLanguage);
}

export function isValidDuration(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 60 && Number(value) <= 1200;
}