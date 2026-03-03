
import { describe, it, expect } from 'vitest';
import { normalizeDomain, hashDomain, resolveEffectiveMode, resolveFeatureFlags } from '@mugenblock/shared';

describe('Domain Utilities', () => {
    it('should normalize domains correctly', () => {
        expect(normalizeDomain('EXAMPLE.COM')).toBe('example.com');
        expect(normalizeDomain('https://google.com/search')).toBe('google.com');
        expect(normalizeDomain('sub.example.co.uk')).toBe('sub.example.co.uk');
        expect(normalizeDomain('')).toBeNull();
        expect(normalizeDomain('not a domain')).toBeNull();
    });

    it('should generate consistent hashes', () => {
        const h1 = hashDomain('example.com');
        const h2 = hashDomain('example.com');
        const h3 = hashDomain('other.com');
        expect(h1).toBe(h2);
        expect(h1).not.toBe(h3);
        expect(typeof h1).toBe('number');
    });

    it('resolves effective mode with safety overrides', () => {
        expect(resolveEffectiveMode('standard', null, Date.now())).toBe('standard');
        expect(resolveEffectiveMode('advanced', { disabled: true }, Date.now())).toBe('lite');
        expect(resolveEffectiveMode('advanced', { safeModeUntil: Date.now() + 10_000 }, Date.now())).toBe('lite');
        expect(resolveEffectiveMode('advanced', { mode: 'standard' }, Date.now())).toBe('standard');
    });

    it('resolves mode feature flags', () => {
        expect(resolveFeatureFlags('lite', null)).toEqual({
            cosmetics: false,
            scriptGuard: false,
            mainWorld: false,
        });
        expect(resolveFeatureFlags('standard', { cosmeticsOff: true })).toEqual({
            cosmetics: false,
            scriptGuard: false,
            mainWorld: false,
        });
        expect(resolveFeatureFlags('advanced', { siteFixesOff: false, mainWorldOff: true })).toEqual({
            cosmetics: true,
            scriptGuard: true,
            mainWorld: false,
        });
    });
});
