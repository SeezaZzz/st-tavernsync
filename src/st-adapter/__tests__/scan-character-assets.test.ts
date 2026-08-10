import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    setItem: vi.fn(async () => undefined),
    getItem: vi.fn(async () => null),
    listCharacters: vi.fn(),
    listCharacterAssets: vi.fn(),
    postJson: vi.fn(),
    getBytes: vi.fn(),
    listGroups: vi.fn(),
    makeSettingsItem: vi.fn(),
}));

vi.mock('../http', () => ({
    stFetchJson: mocks.postJson,
    stFetchBytes: mocks.getBytes,
}));

vi.mock('../../state/store', () => ({
    getSyncStore: () => ({ setItem: mocks.setItem, getItem: mocks.getItem }),
}));

vi.mock('../read', () => ({
    fetchSettingsBundle: vi.fn(async () => ({
        settings: {},
        world_names: [],
        presets: [],
        themes: [],
        quickReplyPresets: [],
    })),
    makeSettingsItem: mocks.makeSettingsItem,
    listWorldInfo: vi.fn(async () => []),
    listPresets: vi.fn(async () => []),
    listThemes: vi.fn(async () => []),
    listQuickReplies: vi.fn(async () => []),
    listPersonas: vi.fn(async () => []),
    listCharacters: mocks.listCharacters,
    listChatsForCharacter: vi.fn(async () => []),
    listGroups: mocks.listGroups,
}));

vi.mock('../character-assets', () => ({
    listCharacterAssets: mocks.listCharacterAssets,
}));

import type { SyncScopeSettings } from '../../settings';
import { scanLocal } from '../scan';

const charactersOnly: SyncScopeSettings = {
    settings: false,
    characters: true,
    chats: false,
    lorebooks: false,
    presets: false,
    personas: false,
    groups: false,
    quickreplies: false,
    themes: false,
};

const groupsOnly: SyncScopeSettings = {
    ...charactersOnly,
    characters: false,
    groups: true,
};

const settingsOnly: SyncScopeSettings = {
    ...charactersOnly,
    characters: false,
    settings: true,
};

describe('character scope scan', () => {
    beforeEach(() => {
        mocks.setItem.mockClear();
        mocks.getItem.mockClear();
        mocks.listCharacters.mockReset();
        mocks.listCharacterAssets.mockReset();
        mocks.postJson.mockReset();
        mocks.postJson.mockResolvedValue([]);
        mocks.getBytes.mockReset();
        mocks.listGroups.mockReset();
        mocks.listGroups.mockResolvedValue({ groups: [], groupChats: [] });
        mocks.makeSettingsItem.mockReset();
        mocks.makeSettingsItem.mockResolvedValue({
            bytes: new Uint8Array([9]),
            item: { id: 'settings/root', type: 'settings', hash: 'settings', size: 1, mtime: 1 },
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('adds the character card and every character asset to the manifest', async () => {
        mocks.listCharacters.mockResolvedValue([{
            avatar: 'Aqua.png',
            name: 'Aqua',
            bytes: new Uint8Array([1]),
            item: { id: 'character/Aqua.png', type: 'character', hash: 'card', size: 1, mtime: 1 },
        }]);
        mocks.listCharacterAssets.mockResolvedValue([{
            bytes: new Uint8Array([2]),
            item: {
                id: 'characterasset/Aqua/joy.png',
                type: 'characterasset',
                hash: 'asset',
                size: 1,
                mtime: 1,
            },
        }]);
        mocks.postJson.mockResolvedValue([{
            avatar: 'Aqua.png',
            name: 'Aqua',
            fav: true,
            data: { extensions: { fav: true } },
        }]);

        const result = await scanLocal({ deviceName: 'pc', scope: charactersOnly });

        expect(Object.keys(result.manifest.items).sort()).toEqual([
            'character/Aqua.png',
            'characterasset/Aqua/joy.png',
            'characterstate/Aqua.png',
        ]);
        expect(mocks.listCharacterAssets).toHaveBeenCalledWith('Aqua');
    });

    it('uses the avatar basename for the asset folder when the card display name differs', async () => {
        mocks.listCharacters.mockResolvedValue([{
            avatar: 'Free Use World.png',
            name: 'Free Use World.',
            bytes: new Uint8Array([1]),
            item: {
                id: 'character/Free Use World.png',
                type: 'character',
                hash: 'card',
                size: 1,
                mtime: 1,
            },
        }]);
        mocks.listCharacterAssets.mockResolvedValue([]);

        await scanLocal({ deviceName: 'pc', scope: charactersOnly });

        expect(mocks.listCharacterAssets).toHaveBeenCalledWith('Free Use World');
    });

    it('also scans the normalized display-name folder for an existing character', async () => {
        mocks.listCharacters.mockResolvedValue([{
            avatar: 'default_Seraphina.png',
            name: 'Seraphina',
            bytes: new Uint8Array([1]),
            item: {
                id: 'character/default_Seraphina.png',
                type: 'character',
                hash: 'card',
                size: 1,
                mtime: 1,
            },
        }]);
        mocks.listCharacterAssets.mockImplementation(async (folder: string) => folder === 'Seraphina'
            ? [{
                bytes: new Uint8Array([2]),
                item: {
                    id: 'characterasset/Seraphina/joy.png',
                    type: 'characterasset',
                    hash: 'asset',
                    size: 1,
                    mtime: 1,
                },
            }]
            : []);

        const result = await scanLocal({ deviceName: 'pc', scope: charactersOnly });

        expect(mocks.listCharacterAssets.mock.calls.map(([folder]) => folder)).toEqual([
            'default_Seraphina',
            'Seraphina',
        ]);
        expect(Object.keys(result.manifest.items).sort()).toEqual([
            'character/default_Seraphina.png',
            'characterasset/Seraphina/joy.png',
        ]);
    });

    it('adds a custom group avatar from user images to the group snapshot', async () => {
        const groupBytes = new TextEncoder().encode(JSON.stringify({
            id: 'g1',
            avatar_url: '/user/images/group-avatar.jpg',
        }));
        mocks.listGroups.mockResolvedValue({
            groups: [{
                bytes: groupBytes,
                item: { id: 'group/g1', type: 'group', hash: 'group', size: 1, mtime: 1 },
            }],
            groupChats: [],
        });
        mocks.getBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));

        const result = await scanLocal({ deviceName: 'pc', scope: groupsOnly });

        expect(Object.keys(result.manifest.items).sort()).toEqual([
            'group/g1',
            'userimage/group-avatar.jpg',
        ]);
        expect(mocks.getBytes).toHaveBeenCalledWith('/user/images/group-avatar.jpg');
    });

    it('skips a missing local group avatar so Pull can restore it from remote', async () => {
        const groupBytes = new TextEncoder().encode(JSON.stringify({
            id: 'g1',
            avatar_url: '/user/images/missing.jpg',
        }));
        mocks.listGroups.mockResolvedValue({
            groups: [{
                bytes: groupBytes,
                item: { id: 'group/g1', type: 'group', hash: 'group', size: 1, mtime: 1 },
            }],
            groupChats: [],
        });
        mocks.getBytes.mockRejectedValue(new Error('GET /user/images/missing.jpg failed: 404'));

        const result = await scanLocal({ deviceName: 'phone', scope: groupsOnly });

        expect(Object.keys(result.manifest.items)).toEqual(['group/g1']);
    });

    it('records installable third-party extensions under the Settings scope', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify([{
            type: 'global',
            name: 'third-party/rpg-companion-sillytavern',
        }]), { status: 200, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);
        mocks.postJson.mockResolvedValue({
            remoteUrl: 'https://github.com/example/rpg-companion-sillytavern.git',
        });

        const result = await scanLocal({ deviceName: 'pc', scope: settingsOnly });

        expect(Object.keys(result.manifest.items).sort()).toEqual([
            'extension/rpg-companion-sillytavern',
            'settings/root',
        ]);
    });

    it('does not include TavernSync itself in the extension snapshot', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify([{
            type: 'global',
            name: 'third-party/st-tavernsync',
        }]), { status: 200, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);
        mocks.postJson.mockResolvedValue({
            remoteUrl: 'https://github.com/SeezaZzz/st-tavernsync.git',
        });

        const result = await scanLocal({ deviceName: 'pc', scope: settingsOnly });

        expect(Object.keys(result.manifest.items)).toEqual(['settings/root']);
    });
});
