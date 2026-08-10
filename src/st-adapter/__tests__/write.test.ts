import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({
    postJson: vi.fn(async (url: string, body: unknown): Promise<unknown> => {
        if (url === '/api/images/upload') {
            const upload = body as { filename: string };
            return { path: `user/images/${upload.filename}` };
        }
        return undefined;
    }),
    postForm: vi.fn(async (_url: string, _form: FormData) => ({
        file_name: 'unused',
        path: 'unused',
    })),
    getBytes: vi.fn(async (_url: string): Promise<Uint8Array> => new Uint8Array([1, 2, 3])),
}));

vi.mock('../http', () => ({
    stFetchJson: http.postJson,
    stFetchForm: http.postForm,
    stFetchBytes: http.getBytes,
}));

import type { ItemType } from '../../sync-core/types';
import {
    applyLocalItem,
    applyPreparedPersonas,
    preparePersona,
} from '../write';

describe('scoped restore writers', () => {
    beforeEach(() => {
        http.postJson.mockClear();
        http.postForm.mockClear();
        http.getBytes.mockClear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each([
        ['theme', 'theme/Dark', '/api/themes/save'],
        ['quickreply', 'quickreply/QR', '/api/quick-replies/save'],
    ] as const)('writes %s through its existing ST endpoint', async (type, id, url) => {
        const body = { name: id.split('/')[1] };
        const bytes = new TextEncoder().encode(JSON.stringify(body));

        await applyLocalItem(id, type as ItemType, bytes, false);

        expect(http.postJson).toHaveBeenCalledWith(url, body);
    });

    it('preserves the complete character filename when it contains dots', async () => {
        await applyLocalItem(
            "character/Mr. A's Farm.png",
            'character',
            new Uint8Array([1, 2, 3]),
            false,
        );

        const form = http.postForm.mock.calls[0][1] as FormData;
        expect(form.get('preserved_name')).toBe("Mr. A's Farm.png");
    });

    it('restores a character asset through the existing sprites upload endpoint', async () => {
        await applyLocalItem(
            'characterasset/Aqua/bgm/surprise_01.ogg',
            'characterasset' as ItemType,
            new Uint8Array([4, 5, 6]),
            false,
        );

        expect(http.postForm).toHaveBeenCalledTimes(1);
        expect(http.postForm.mock.calls[0][0]).toBe('/api/sprites/upload');
        const form = http.postForm.mock.calls[0][1] as FormData;
        expect(form.get('name')).toBe('Aqua/bgm');
        expect(form.get('spriteName')).toBe('surprise_01');
        expect((form.get('avatar') as File).name).toBe('surprise_01.ogg');
    });

    it('restores favorite state after the character card import', async () => {
        const bytes = new TextEncoder().encode(JSON.stringify({ fav: true }));

        await applyLocalItem(
            'characterstate/Story Teller.png',
            'characterstate' as ItemType,
            bytes,
            false,
        );

        expect(http.postJson).toHaveBeenCalledWith('/api/characters/merge-attributes', {
            avatar: 'Story Teller.png',
            fav: true,
            data: { extensions: { fav: true } },
        });
    });

    it('restores a group avatar to the exact user image path', async () => {
        await applyLocalItem(
            'userimage/2025-04-06@13h08m23s.jpg',
            'userimage' as ItemType,
            new Uint8Array([1, 2, 3]),
            false,
        );

        expect(http.postJson).toHaveBeenCalledWith('/api/images/upload', {
            image: 'AQID',
            format: 'jpg',
            filename: '2025-04-06@13h08m23s.jpg',
        });
        expect(http.getBytes).toHaveBeenCalledWith('/user/images/2025-04-06@13h08m23s.jpg');
    });

    it('rejects a user image upload when the bytes read back do not match', async () => {
        http.getBytes.mockResolvedValueOnce(new Uint8Array([9, 9, 9]));

        await expect(applyLocalItem(
            'userimage/2025-04-06@13h08m23s.jpg',
            'userimage' as ItemType,
            new Uint8Array([1, 2, 3]),
            false,
        )).rejects.toThrow('User image verification failed');
    });

    it('installs a missing third-party extension from its recorded repository', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })));
        const descriptor = {
            name: 'rpg-companion-sillytavern',
            url: 'https://github.com/example/rpg-companion-sillytavern.git',
            global: true,
        };

        await applyLocalItem(
            `extension/${descriptor.name}`,
            'extension' as ItemType,
            new TextEncoder().encode(JSON.stringify(descriptor)),
            false,
        );

        expect(http.postJson).toHaveBeenCalledWith('/api/extensions/install', {
            url: descriptor.url,
            global: true,
        });
    });

    it('never tries to reinstall TavernSync while TavernSync is performing the restore', async () => {
        const descriptor = {
            name: 'st-tavernsync',
            url: 'https://github.com/SeezaZzz/st-tavernsync.git',
            global: true,
        };

        await applyLocalItem(
            `extension/${descriptor.name}`,
            'extension' as ItemType,
            new TextEncoder().encode(JSON.stringify(descriptor)),
            false,
        );

        expect(http.postJson).not.toHaveBeenCalled();
    });

    it('skips an extension that SillyTavern already reports as installed', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{
            type: 'global',
            name: 'third-party/rpg-companion-sillytavern',
        }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })));
        const descriptor = {
            name: 'rpg-companion-sillytavern',
            url: 'https://github.com/example/rpg-companion-sillytavern.git',
            global: true,
        };

        await applyLocalItem(
            `extension/${descriptor.name}`,
            'extension' as ItemType,
            new TextEncoder().encode(JSON.stringify(descriptor)),
            false,
        );

        expect(http.postJson).not.toHaveBeenCalled();
    });

    it('merges multiple persona metadata records with one settings read and one save', async () => {
        http.postJson.mockImplementation(async (url: string) => {
            if (url === '/api/settings/get') {
                return { settings: JSON.stringify({ power_user: {} }) };
            }
            return undefined;
        });
        const prepared = await Promise.all([
            preparePersona({ avatarId: 'a.png', name: 'A', description: null, imageBase64: '' }),
            preparePersona({ avatarId: 'b.png', name: 'B', description: null, imageBase64: '' }),
        ]);

        await applyPreparedPersonas(prepared);

        expect(http.postJson.mock.calls.map(call => call[0])).toEqual([
            '/api/settings/get',
            '/api/settings/save',
        ]);
        const saved = http.postJson.mock.calls[1][1] as Record<string, any>;
        expect(saved.power_user.personas).toEqual({ 'a.png': 'A', 'b.png': 'B' });
    });
});
