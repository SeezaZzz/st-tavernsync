import { describe, expect, it } from 'vitest';

import {
    createPullPerformanceStore,
    getPullPerformanceConfig,
    recommendPullPerformanceProfile,
} from '../pull-performance-profile';

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    };
}

describe('Pull performance profiles', () => {
    it('stores only valid device-local profiles', () => {
        const storage = memoryStorage();
        const store = createPullPerformanceStore(storage);
        expect(store.load()).toBeNull();
        store.save('mobile');
        expect(store.load()).toBe('mobile');
        storage.setItem('tavernsync:drive-v2-pull-profile', 'turbo');
        expect(store.load()).toBeNull();
    });

    it('defines the approved mobile and PC bounds', () => {
        expect(getPullPerformanceConfig('mobile')).toMatchObject({
            aggregateCap: 4,
            minimumAggregateCap: 2,
            encryptedBudgetBytes: 32 * 1024 * 1024,
            plaintextBudgetBytes: 24 * 1024 * 1024,
        });
        expect(getPullPerformanceConfig('pc')).toMatchObject({
            aggregateCap: 23,
            encryptedBudgetBytes: 64 * 1024 * 1024,
            plaintextBudgetBytes: 48 * 1024 * 1024,
        });
    });

    it('recommends stable mode for mobile user agents and fast mode otherwise', () => {
        expect(recommendPullPerformanceProfile({ userAgent: 'Mozilla/5.0 (iPhone)' })).toBe('mobile');
        expect(recommendPullPerformanceProfile({ userAgent: 'Mozilla/5.0 (Linux; Android 15)' })).toBe('mobile');
        expect(recommendPullPerformanceProfile({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe('pc');
    });
});
