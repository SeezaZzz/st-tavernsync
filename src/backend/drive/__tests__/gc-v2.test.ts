import { describe, expect, it } from 'vitest';

import { collectDriveV2Garbage } from '../gc-v2';

describe('Drive v2 garbage collection', () => {
    it('trashes only old unreferenced packs and never the active head', async () => {
        const trashed: string[] = [];
        const store = {
            listCommits: async () => [{
                fileId: 'head-file',
                commitId: 'head',
                parents: [],
                createdTime: '2026-08-10T00:00:00Z',
            }],
            readManifest: async () => ({
                schema: 2 as const,
                storage: 'drive-pack-v2' as const,
                device: 'pc',
                updatedAt: 1,
                chunkBytes: 1,
                packBytes: 32,
                items: {
                    a: {
                        id: 'preset/a',
                        type: 'preset' as const,
                        hash: 'h',
                        size: 1,
                        mtime: 1,
                        chunks: [{
                            packName: 'live-pack',
                            offset: 0,
                            boxedLength: 1,
                            plainLength: 1,
                            chunkHash: 'h',
                        }],
                    },
                },
            }),
            listPacks: async () => new Map([
                ['live-pack', {
                    id: 'file:live-pack',
                    name: 'live-pack',
                    createdTime: '2026-07-01T00:00:00Z',
                }],
                ['old-pack', {
                    id: 'file:old-pack',
                    name: 'old-pack',
                    createdTime: '2026-07-01T00:00:00Z',
                }],
            ]),
        };
        const client = { trashFile: async (id: string) => { trashed.push(id); } };

        const result = await collectDriveV2Garbage(store, client, {
            now: () => Date.parse('2026-08-10T00:00:00Z'),
        });

        expect(trashed).toEqual(['file:old-pack']);
        expect(result).toEqual({ trashedPacks: 1, trashedCommits: 0 });
    });

    it('refuses cleanup while concurrent heads exist', async () => {
        const commits = ['a', 'b'].map(commitId => ({
            fileId: `file-${commitId}`,
            commitId,
            parents: [],
            createdTime: '2026-08-10T00:00:00Z',
        }));

        await expect(collectDriveV2Garbage({
            listCommits: async () => commits,
            readManifest: async () => { throw new Error('not used'); },
            listPacks: async () => new Map(),
        }, { trashFile: async () => undefined }))
            .rejects.toThrow(/concurrent heads/i);
    });
});
