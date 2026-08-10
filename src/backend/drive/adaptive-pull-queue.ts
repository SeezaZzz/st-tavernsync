import type { DrivePackItemV2 } from './pack-types';

export type PullCostClass = 'small' | 'medium' | 'heavy' | 'serial';

export interface PullJob {
    readonly item: DrivePackItemV2;
    readonly cost: PullCostClass;
    readonly dependencies: readonly string[];
}

export interface AdaptivePullSnapshot {
    readonly completed: number;
    readonly total: number;
    readonly lastItemType: string;
    readonly itemsPerSecond: number;
    readonly activeWriters: number;
    readonly etaSeconds: number;
    readonly limits: Record<PullCostClass, number>;
}

export interface AdaptivePullMetrics {
    readonly completed: number;
    readonly maxActiveWriters: number;
    readonly elapsedMs: number;
}

interface PullLimits {
    readonly initial: Record<PullCostClass, number>;
    readonly minimum: Record<PullCostClass, number>;
    readonly maximum: Record<PullCostClass, number>;
}

export interface AdaptivePullQueueOptions {
    readonly jobs: readonly PullJob[];
    readonly run: (job: PullJob) => Promise<void>;
    readonly signal?: AbortSignal;
    readonly now?: () => number;
    readonly limits?: PullLimits;
    readonly onSnapshot?: (snapshot: AdaptivePullSnapshot) => void;
}

const DEFAULT_LIMITS: PullLimits = {
    initial: { small: 12, medium: 8, heavy: 2, serial: 1 },
    minimum: { small: 4, medium: 4, heavy: 1, serial: 1 },
    maximum: { small: 16, medium: 12, heavy: 4, serial: 1 },
};

export function classifyPullJob(
    item: DrivePackItemV2,
    remoteIds: ReadonlySet<string>,
): PullJob {
    const dependencies: string[] = [];
    if (item.type === 'chat') {
        const avatar = item.id.split('/')[1];
        const characterId = `character/${avatar}`;
        if (remoteIds.has(characterId)) dependencies.push(characterId);
    }
    if (item.type === 'characterasset') {
        const encodedName = item.id.split('/')[1];
        const characterId = `character/${decodeURIComponent(encodedName)}.png`;
        if (remoteIds.has(characterId)) dependencies.push(characterId);
    }
    if (item.type === 'characterstate') {
        const avatar = item.id.split('/').slice(1).join('/');
        const characterId = `character/${avatar}`;
        if (remoteIds.has(characterId)) dependencies.push(characterId);
    }

    const cost: PullCostClass = item.type === 'settings'
        ? 'serial'
        : item.type === 'character' || item.size > 4 * 1024 * 1024
            ? 'heavy'
            : item.size > 256 * 1024 || item.type === 'chat'
                ? 'medium'
                : 'small';

    return { item, cost, dependencies };
}

function percentile95(values: readonly number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

export function runAdaptivePullQueue(
    options: AdaptivePullQueueOptions,
): Promise<AdaptivePullMetrics> {
    const now = options.now ?? (() => performance.now());
    const bounds = options.limits ?? DEFAULT_LIMITS;
    const limits = { ...bounds.initial };
    const pending = [...options.jobs];
    const completedIds = new Set<string>();
    const activeByClass: Record<PullCostClass, number> = {
        small: 0,
        medium: 0,
        heavy: 0,
        serial: 0,
    };
    const sampleDurations: Record<PullCostClass, number[]> = {
        small: [],
        medium: [],
        heavy: [],
        serial: [],
    };
    const previousP95: Record<PullCostClass, number> = {
        small: 0,
        medium: 0,
        heavy: 0,
        serial: 0,
    };
    const startedAt = now();
    let completed = 0;
    let active = 0;
    let maxActiveWriters = 0;
    let settled = false;

    return new Promise((resolve, reject) => {
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            reject(error);
        };

        const adjust = (cost: PullCostClass): void => {
            const samples = sampleDurations[cost];
            if (samples.length < 16) return;
            const p95 = percentile95(samples.splice(0));
            if (previousP95[cost] > 0 && p95 >= previousP95[cost] * 2) {
                limits[cost] = Math.max(bounds.minimum[cost], Math.floor(limits[cost] / 2));
            } else {
                limits[cost] = Math.min(bounds.maximum[cost], limits[cost] + 1);
            }
            previousP95[cost] = p95;
        };

        const dispatch = (): void => {
            if (settled) return;
            try {
                options.signal?.throwIfAborted();
            } catch (error) {
                fail(error);
                return;
            }

            let launched = false;
            for (let index = 0; index < pending.length;) {
                const job = pending[index];
                const ready = job.dependencies.every(id => completedIds.has(id));
                if (!ready || activeByClass[job.cost] >= limits[job.cost]) {
                    index += 1;
                    continue;
                }

                pending.splice(index, 1);
                launched = true;
                active += 1;
                activeByClass[job.cost] += 1;
                maxActiveWriters = Math.max(maxActiveWriters, active);
                const jobStartedAt = now();

                void options.run(job).then(() => {
                    sampleDurations[job.cost].push(Math.max(0, now() - jobStartedAt));
                    completed += 1;
                    completedIds.add(job.item.id);
                    adjust(job.cost);

                    const elapsedMs = Math.max(1, now() - startedAt);
                    const itemsPerSecond = completed / (elapsedMs / 1_000);
                    options.onSnapshot?.({
                        completed,
                        total: options.jobs.length,
                        lastItemType: job.item.type,
                        itemsPerSecond,
                        activeWriters: active,
                        etaSeconds: itemsPerSecond > 0
                            ? (options.jobs.length - completed) / itemsPerSecond
                            : 0,
                        limits: { ...limits },
                    });
                }, error => {
                    limits[job.cost] = Math.max(bounds.minimum[job.cost], limits[job.cost] - 1);
                    fail(error);
                }).finally(() => {
                    active -= 1;
                    activeByClass[job.cost] -= 1;
                    if (settled) return;
                    if (completed === options.jobs.length) {
                        settled = true;
                        resolve({
                            completed,
                            maxActiveWriters,
                            elapsedMs: Math.max(0, now() - startedAt),
                        });
                        return;
                    }
                    queueMicrotask(dispatch);
                });
            }

            if (!launched && active === 0 && pending.length > 0) {
                fail(new Error(`Pull dependency deadlock: ${pending.map(job => job.item.id).join(', ')}`));
            } else if (!launched && active === 0 && pending.length === 0 && !settled) {
                settled = true;
                resolve({
                    completed,
                    maxActiveWriters,
                    elapsedMs: Math.max(0, now() - startedAt),
                });
            }
        };

        dispatch();
    });
}
