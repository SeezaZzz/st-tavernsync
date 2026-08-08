import type { ItemType } from '../sync-core/types';

const STORAGE_KEY = 'tavernsync_pull_crash_journal_v1';

export type PullStage = 'downloading' | 'decrypting' | 'prepared' | 'storing' | 'applying';

export interface PullCrashItem {
    id: string;
    type: ItemType;
    hash: string;
    size: number;
    stage: PullStage;
    updatedAt: number;
}

export type PullCrashUpdate = Omit<PullCrashItem, 'updatedAt'>;

export interface PullCrashStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

interface StoredJournal {
    version: 1;
    active: Record<string, PullCrashItem>;
}

function parseJournal(raw: string | null): StoredJournal {
    if (!raw) return { version: 1, active: {} };
    try {
        const value = JSON.parse(raw) as Partial<StoredJournal>;
        if (value.version !== 1 || !value.active || typeof value.active !== 'object') {
            return { version: 1, active: {} };
        }
        return { version: 1, active: value.active };
    } catch {
        return { version: 1, active: {} };
    }
}

export class PullCrashJournal {
    constructor(
        private readonly storage: PullCrashStorage,
        private readonly now: () => number = () => Date.now(),
    ) {}

    read(): PullCrashItem[] {
        try {
            return Object.values(parseJournal(this.storage.getItem(STORAGE_KEY)).active)
                .sort((a, b) => a.id.localeCompare(b.id));
        } catch {
            return [];
        }
    }

    startRun(): void {
        try {
            this.storage.removeItem(STORAGE_KEY);
        } catch {
            // Diagnostics must never interrupt a Pull when storage is unavailable.
        }
    }

    update(item: PullCrashUpdate): void {
        try {
            const state = parseJournal(this.storage.getItem(STORAGE_KEY));
            state.active[item.id] = { ...item, updatedAt: this.now() };
            this.storage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch {
            // Diagnostics must never interrupt a Pull when storage is unavailable.
        }
    }

    finish(id: string): void {
        try {
            const state = parseJournal(this.storage.getItem(STORAGE_KEY));
            delete state.active[id];
            if (Object.keys(state.active).length === 0) {
                this.storage.removeItem(STORAGE_KEY);
            } else {
                this.storage.setItem(STORAGE_KEY, JSON.stringify(state));
            }
        } catch {
            // Diagnostics must never interrupt a Pull when storage is unavailable.
        }
    }
}

function formatMiB(bytes: number): string {
    return `${(bytes / 1_048_576).toFixed(2)} MiB`;
}

export function formatInterruptedPull(items: PullCrashItem[]): string {
    return [...items]
        .sort((a, b) => (a.stage === 'applying' ? -1 : 0) - (b.stage === 'applying' ? -1 : 0) || a.id.localeCompare(b.id))
        .map((item) => `${item.stage} ${item.id} (${formatMiB(item.size)})`)
        .join(' | ');
}
