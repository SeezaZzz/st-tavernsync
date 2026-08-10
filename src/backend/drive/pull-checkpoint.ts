import type { DriveV2PullCheckpointState } from '../../settings';

export type { DriveV2PullCheckpointState } from '../../settings';

export interface PullCheckpointStore {
    load(): DriveV2PullCheckpointState | null;
    save(value: DriveV2PullCheckpointState | null): void;
}

interface LocalStorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

const CHECKPOINT_STORAGE_KEY = 'tavernsync:drive-v2-pull-checkpoint';
const memoryStorageValues = new Map<string, string>();
const memoryStorage: LocalStorageLike = {
    getItem: key => memoryStorageValues.get(key) ?? null,
    setItem: (key, value) => { memoryStorageValues.set(key, value); },
    removeItem: key => { memoryStorageValues.delete(key); },
};

export function createLocalStorageCheckpointStore(
    storage: LocalStorageLike,
    key = CHECKPOINT_STORAGE_KEY,
): PullCheckpointStore {
    return {
        load: () => {
            const raw = storage.getItem(key);
            if (!raw) return null;
            try {
                return JSON.parse(raw) as DriveV2PullCheckpointState;
            } catch {
                storage.removeItem(key);
                return null;
            }
        },
        save: value => {
            if (value === null) {
                storage.removeItem(key);
                return;
            }
            storage.setItem(key, JSON.stringify(value));
        },
    };
}

function extensionCheckpointStore(): PullCheckpointStore {
    return createLocalStorageCheckpointStore(globalThis.localStorage ?? memoryStorage);
}

export class DriveV2PullCheckpoint {
    readonly completedIds: Set<string>;
    private dirty = 0;
    private lastSavedAt: number;

    constructor(
        readonly commitId: string,
        private readonly store: PullCheckpointStore = extensionCheckpointStore(),
        private readonly now: () => number = () => Date.now(),
    ) {
        const loaded = store.load();
        this.completedIds = new Set(
            loaded?.commitId === commitId ? loaded.completedItemIds : [],
        );
        this.lastSavedAt = this.now();
    }

    markCompleted(id: string): void {
        if (this.completedIds.has(id)) return;
        this.completedIds.add(id);
        this.dirty += 1;
        this.flushIfDue();
    }

    flushIfDue(force = false): void {
        if (!this.dirty && !force) return;
        const currentTime = this.now();
        if (!force && this.dirty < 25 && currentTime - this.lastSavedAt < 2_000) return;

        this.store.save({
            commitId: this.commitId,
            completedItemIds: [...this.completedIds],
            updatedAt: currentTime,
        });
        this.dirty = 0;
        this.lastSavedAt = currentTime;
    }

    finish(): void {
        this.dirty = 0;
        this.store.save(null);
    }
}
