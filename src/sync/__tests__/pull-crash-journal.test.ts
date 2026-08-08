import { describe, expect, it } from 'vitest';
import {
    PullCrashJournal,
    formatInterruptedPull,
    type PullCrashStorage,
} from '../pull-crash-journal';

class MemoryStorage implements PullCrashStorage {
    readonly values = new Map<string, string>();

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }

    removeItem(key: string): void {
        this.values.delete(key);
    }
}

describe('PullCrashJournal', () => {
    it('persists every active item and its latest stage across a WebView restart', () => {
        const storage = new MemoryStorage();
        let now = 100;
        const journal = new PullCrashJournal(storage, () => ++now);

        journal.update({ id: 'chat/a/one', type: 'chat', hash: 'hash-a', size: 12, stage: 'downloading' });
        journal.update({ id: 'chat/b/two', type: 'chat', hash: 'hash-b', size: 34, stage: 'decrypting' });
        journal.update({ id: 'chat/a/one', type: 'chat', hash: 'hash-a', size: 12, stage: 'prepared' });

        const restored = new PullCrashJournal(storage).read();
        expect(restored).toEqual([
            {
                id: 'chat/a/one',
                type: 'chat',
                hash: 'hash-a',
                size: 12,
                stage: 'prepared',
                updatedAt: 103,
            },
            {
                id: 'chat/b/two',
                type: 'chat',
                hash: 'hash-b',
                size: 34,
                stage: 'decrypting',
                updatedAt: 102,
            },
        ]);
    });

    it('removes successful items and deletes the journal after the last item finishes', () => {
        const storage = new MemoryStorage();
        const journal = new PullCrashJournal(storage, () => 1);
        journal.update({ id: 'character/a', type: 'character', hash: 'a', size: 10, stage: 'applying' });
        journal.update({ id: 'character/b', type: 'character', hash: 'b', size: 20, stage: 'prepared' });

        journal.finish('character/a');
        expect(journal.read().map((item) => item.id)).toEqual(['character/b']);

        journal.finish('character/b');
        expect(journal.read()).toEqual([]);
        expect(storage.values.size).toBe(0);
    });

    it('starts a fresh diagnostic journal for each Pull attempt', () => {
        const storage = new MemoryStorage();
        const journal = new PullCrashJournal(storage, () => 1);
        journal.update({ id: 'chat/stale', type: 'chat', hash: 'old', size: 10, stage: 'applying' });

        journal.startRun();

        expect(journal.read()).toEqual([]);
        expect(storage.values.size).toBe(0);
    });

    it('fails closed when browser storage is unavailable or corrupt', () => {
        const broken: PullCrashStorage = {
            getItem: () => '{not json',
            setItem: () => { throw new Error('quota'); },
            removeItem: () => { throw new Error('blocked'); },
        };
        const journal = new PullCrashJournal(broken);

        expect(journal.read()).toEqual([]);
        expect(() => journal.update({
            id: 'chat/a', type: 'chat', hash: 'hash', size: 1, stage: 'downloading',
        })).not.toThrow();
        expect(() => journal.finish('chat/a')).not.toThrow();
    });

    it('formats the applying item first without exposing payload contents', () => {
        const message = formatInterruptedPull([
            { id: 'chat/second', type: 'chat', hash: 'secret-hash', size: 2_097_152, stage: 'prepared', updatedAt: 2 },
            { id: 'chat/first', type: 'chat', hash: 'other-hash', size: 1_048_576, stage: 'applying', updatedAt: 1 },
        ]);

        expect(message).toContain('applying chat/first (1.00 MiB)');
        expect(message).toContain('prepared chat/second (2.00 MiB)');
        expect(message).not.toContain('secret-hash');
        expect(message).not.toContain('other-hash');
    });
});
