import { describe, expect, it } from 'vitest';

import type { ItemType } from '../../sync-core/types';
import { listLocalInventory, type InventoryApi } from '../inventory';

describe('lightweight local inventory', () => {
    it('lists enabled IDs without downloading chat bodies or character PNG bytes', async () => {
        const calls: string[] = [];
        const api: InventoryApi = {
            async head(url: string): Promise<boolean> {
                calls.push(`HEAD ${url}`);
                return true;
            },
            async getJson<T>(url: string): Promise<T> {
                calls.push(url);
                if (url === '/api/extensions/discover') {
                    return [{ name: 'third-party/rpg-companion-sillytavern', type: 'global' }] as T;
                }
                return [{ path: '/characters/Alice/joy.png?t=1' }] as T;
            },
            async postJson<T>(url: string): Promise<T> {
                calls.push(url);
                if (url === '/api/extensions/version') {
                    return { remoteUrl: 'https://github.com/example/rpg-companion.git' } as T;
                }
                const values: Record<string, unknown> = {
                    '/api/settings/get': {
                        settings: JSON.stringify({
                            power_user: { personas: { 'me.png': 'Me' } },
                        }),
                        world_names: ['Lore'],
                        themes: [{ name: 'Dark' }],
                        quickReplyPresets: [{ name: 'QR' }],
                        koboldai_setting_names: ['K'],
                        instruct: [{ name: 'Instruction' }],
                    },
                    '/api/characters/all': [{ avatar: 'Alice.png', fav: true }],
                    '/api/characters/chats': [{ file_id: 'chat-1', file_name: 'chat-1.jsonl' }],
                    '/api/assets/character?name=Alice&category=bgm': [
                        '/characters/Alice/bgm/theme.ogg',
                    ],
                    '/api/groups/all': [{
                        id: 'g1',
                        chats: ['gc1'],
                        avatar_url: '/user/images/group-avatar.jpg',
                    }],
                };
                return values[url] as T;
            },
        };

        const inventory = await listLocalInventory(new Set<ItemType>([
            'settings', 'extension', 'worldinfo', 'preset', 'theme', 'quickreply', 'persona',
            'character', 'characterstate', 'characterasset', 'chat',
            'group', 'groupchat', 'userimage',
        ]), api);

        expect([...inventory.keys()].sort()).toEqual([
            'character/Alice.png',
            'characterasset/Alice/bgm/theme.ogg',
            'characterasset/Alice/joy.png',
            'characterstate/Alice.png',
            'chat/Alice.png/chat-1',
            'extension/rpg-companion-sillytavern',
            'group/g1',
            'groupchat/gc1',
            'persona/me.png',
            'preset/instruct/Instruction',
            'preset/kobold/K',
            'quickreply/QR',
            'settings/root',
            'theme/Dark',
            'userimage/group-avatar.jpg',
            'worldinfo/Lore',
        ]);
        expect(calls).not.toContain('/api/chats/get');
        expect(calls.every(url => !url.startsWith('/characters/'))).toBe(true);
        expect(calls).toContain('HEAD /user/images/group-avatar.jpg');
    });

    it('does not count a group image whose referenced file is missing', async () => {
        const api: InventoryApi = {
            async head(): Promise<boolean> {
                return false;
            },
            async getJson<T>(): Promise<T> {
                return [] as T;
            },
            async postJson<T>(url: string): Promise<T> {
                if (url === '/api/groups/all') {
                    return [{
                        id: 'g1',
                        avatar_url: '/user/images/missing.jpg',
                    }] as T;
                }
                return [] as T;
            },
        };

        const inventory = await listLocalInventory(new Set<ItemType>(['group', 'userimage']), api);

        expect([...inventory.keys()]).toEqual(['group/g1']);
    });

    it('calls only endpoints required by enabled scopes', async () => {
        const calls: string[] = [];
        const api: InventoryApi = {
            async head(): Promise<boolean> {
                return true;
            },
            async getJson<T>(): Promise<T> {
                return [] as T;
            },
            async postJson<T>(url: string): Promise<T> {
                calls.push(url);
                if (url === '/api/characters/all') return [{ avatar: 'Alice.png' }] as T;
                return [] as T;
            },
        };

        const inventory = await listLocalInventory(new Set<ItemType>(['character']), api);

        expect([...inventory]).toEqual([['character/Alice.png', 'character']]);
        expect(calls).toEqual(['/api/characters/all']);
    });
});
