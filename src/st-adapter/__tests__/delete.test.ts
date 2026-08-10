import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemType } from '../../sync-core/types';
import { deleteLocalItem } from '../delete';

const fetchMock = vi.fn<typeof fetch>();
const settings = {
    power_user: {
        personas: { 'me.png': 'Me' },
        persona_descriptions: { 'me.png': { description: 'x' } },
    },
};

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/api/settings/get') {
            return new Response(JSON.stringify({ settings: JSON.stringify(settings) }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        return new Response('', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as unknown as { SillyTavern: unknown }).SillyTavern = {
        getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }),
    };
});

describe('local snapshot deletion', () => {
    it.each([
        ['worldinfo/book', 'worldinfo', '/api/worldinfo/delete', { name: 'book' }],
        ['preset/openai/main', 'preset', '/api/presets/delete', { apiId: 'openai', name: 'main' }],
        ['theme/moon', 'theme', '/api/themes/delete', { name: 'moon' }],
        ['quickreply/common', 'quickreply', '/api/quick-replies/delete', { name: 'common' }],
        ['character/alice.png', 'character', '/api/characters/delete', { avatar_url: 'alice.png', delete_chats: false }],
        ['characterasset/Aqua/bgm/surprise_01.ogg', 'characterasset', '/api/sprites/delete', {
            name: 'Aqua/bgm',
            label: 'surprise_01',
            spriteName: 'surprise_01',
        }],
        ['chat/alice.png/day-1', 'chat', '/api/chats/delete', { avatar_url: 'alice.png', chatfile: 'day-1' }],
        ['group/42', 'group', '/api/groups/delete', { id: '42' }],
        ['groupchat/room-1', 'groupchat', '/api/chats/group/delete', { id: 'room-1' }],
        ['userimage/group-avatar.jpg', 'userimage', '/api/images/delete', {
            path: 'user/images/group-avatar.jpg',
        }],
    ])('maps %s to its SillyTavern delete endpoint', async (id, type, url, body) => {
        await deleteLocalItem(id, type as ItemType);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe(url);
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(body);
    });

    it('removes persona image and metadata together', async () => {
        await deleteLocalItem('persona/me.png', 'persona');

        expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
            '/api/settings/get',
            '/api/settings/save',
            '/api/avatars/delete',
        ]);
        const saved = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
        expect(saved.power_user.personas['me.png']).toBeUndefined();
        expect(saved.power_user.persona_descriptions['me.png']).toBeUndefined();
        expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ avatar: 'me.png' });
    });

    it('treats missing resources as already deleted', async () => {
        fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
        await expect(deleteLocalItem('theme/gone', 'theme')).resolves.toBeUndefined();
    });

    it('refuses to delete settings/root', async () => {
        await expect(deleteLocalItem('settings/root', 'settings'))
            .rejects.toThrow('settings snapshot cannot be deleted');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
