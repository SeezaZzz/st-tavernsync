import { describe, expect, it, vi } from 'vitest';

import { wipeDriveV2RemoteSnapshot } from '../drive-v2-wipe';

describe('Drive v2 remote wipe', () => {
    it('commits one empty encrypted snapshot parented to every current head', async () => {
        const events: string[] = [];
        const commitManifest = vi.fn(async (manifest, parents: readonly string[]) => {
            events.push('commit');
            expect(manifest).toMatchObject({
                schema: 2,
                storage: 'drive-pack-v2',
                device: 'phone',
                items: {},
            });
            expect(parents).toEqual(['head-a', 'head-b']);
            return { commitId: 'empty-head' };
        });
        const store = {
            async listCommits() {
                events.push('list');
                return [
                    { fileId: 'file-a', commitId: 'head-a', parents: ['ancestor'], createdTime: '2026-08-10T01:00:00Z' },
                    { fileId: 'file-b', commitId: 'head-b', parents: ['ancestor'], createdTime: '2026-08-10T02:00:00Z' },
                    { fileId: 'file-old', commitId: 'ancestor', parents: [], createdTime: '2026-08-09T01:00:00Z' },
                ];
            },
            async verifyPacks(packs: readonly unknown[]) {
                events.push('verify');
                expect(packs).toEqual([]);
            },
            commitManifest,
        };

        await expect(wipeDriveV2RemoteSnapshot(store, 'phone')).resolves.toEqual({ commitId: 'empty-head' });
        expect(events).toEqual(['list', 'verify', 'commit']);
    });
});
