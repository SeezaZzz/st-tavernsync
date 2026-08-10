import type { PullLimits } from './adaptive-pull-queue';

export type PullPerformanceProfile = 'mobile' | 'pc';

export interface PullPerformanceConfig {
    readonly profile: PullPerformanceProfile;
    readonly label: 'Mobile / Stable' | 'PC / Fast';
    readonly limits: PullLimits;
    readonly aggregateCap: number;
    readonly minimumAggregateCap: number;
    readonly encryptedBudgetBytes: number;
    readonly plaintextBudgetBytes: number;
    readonly transientRetries: number;
}

interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

const STORAGE_KEY = 'tavernsync:drive-v2-pull-profile';
const memory = new Map<string, string>();
const memoryStorage: StorageLike = {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => { memory.set(key, value); },
    removeItem: key => { memory.delete(key); },
};

const CONFIGS: Record<PullPerformanceProfile, PullPerformanceConfig> = {
    mobile: {
        profile: 'mobile',
        label: 'Mobile / Stable',
        limits: {
            initial: { small: 2, medium: 1, heavy: 1, serial: 1 },
            minimum: { small: 1, medium: 1, heavy: 1, serial: 1 },
            maximum: { small: 3, medium: 2, heavy: 1, serial: 1 },
        },
        aggregateCap: 4,
        minimumAggregateCap: 2,
        encryptedBudgetBytes: 32 * 1024 * 1024,
        plaintextBudgetBytes: 24 * 1024 * 1024,
        transientRetries: 2,
    },
    pc: {
        profile: 'pc',
        label: 'PC / Fast',
        limits: {
            initial: { small: 12, medium: 8, heavy: 2, serial: 1 },
            minimum: { small: 4, medium: 4, heavy: 1, serial: 1 },
            maximum: { small: 16, medium: 12, heavy: 4, serial: 1 },
        },
        aggregateCap: 23,
        minimumAggregateCap: 23,
        encryptedBudgetBytes: 64 * 1024 * 1024,
        plaintextBudgetBytes: 48 * 1024 * 1024,
        transientRetries: 0,
    },
};

export function getPullPerformanceConfig(profile: PullPerformanceProfile): PullPerformanceConfig {
    return CONFIGS[profile];
}

export function recommendPullPerformanceProfile(
    navigatorLike: Pick<Navigator, 'userAgent'> = globalThis.navigator,
): PullPerformanceProfile {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigatorLike.userAgent) ? 'mobile' : 'pc';
}

export function createPullPerformanceStore(
    storage: StorageLike = globalThis.localStorage ?? memoryStorage,
): { load(): PullPerformanceProfile | null; save(profile: PullPerformanceProfile): void } {
    return {
        load: () => {
            const value = storage.getItem(STORAGE_KEY);
            if (value === 'mobile' || value === 'pc') return value;
            if (value !== null) storage.removeItem(STORAGE_KEY);
            return null;
        },
        save: profile => { storage.setItem(STORAGE_KEY, profile); },
    };
}
