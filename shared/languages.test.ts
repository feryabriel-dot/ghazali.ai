import { describe, expect, it } from 'vitest';
import { APPROVED_LANGUAGES, isApprovedLanguage, isValidDuration } from './languages';

describe('production input allowlists', () => {
  it('contains exactly the five approved voice languages', () => {
    expect(APPROVED_LANGUAGES).toEqual(['Bahasa Indonesia', 'Bahasa Melayu Malaysia', 'Bahasa Jawa', 'Bahasa Madura', 'English (US)']);
    expect(isApprovedLanguage('Japanese')).toBe(false);
    expect(isApprovedLanguage('')).toBe(false);
  });

  it('accepts only whole-minute durations from one through twenty minutes', () => {
    expect([60, 180, 300, 600, 900, 1200].every(isValidDuration)).toBe(true);
    expect(isValidDuration(59)).toBe(false);
    expect(isValidDuration(1201)).toBe(false);
    expect(isValidDuration(60.5)).toBe(false);
  });
});