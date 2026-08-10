import {
    getSettings,
    saveSettings,
    type DriveV2PullCheckpointState,
} from '../../settings';

export type { DriveV2PullCheckpointState } from '../../settings';

export interface PullCheckpointStore {
    load(): DriveV2PullCheckpointState | null;
    save(value: DriveV2PullCheckpointState | null): void;
}

function extensionCheckpointStore(): PullCheckpointStore {
    return {
        load: () => getSettings().driveV2PullCheckpoint,
        save: value => {
            getSettings().driveV2PullCheckpoint = value;
            saveSettings();
        },
    };
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
