import { describe, expect, it } from 'vitest';

import type { ItemType } from '../../sync-core/types';
import { listLocalInventory, type InventoryApi } from '../inventory';

describe('lightweight local inventory', () => {
    it('lists enabled IDs without downloading chat bodies or character PNG bytes', async () => {
        const calls: string[] = [];
        const api: InventoryApi = {
            async postJson<T>(url: string): Promise<T> {
                calls.push(url);
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
                    '/api/characters/all': [{ avatar: 'Alice.png' }],
                    '/api/characters/chats': [{ file_id: 'chat-1', file_name: 'chat-1.jsonl' }],
                    '/api/groups/all': [{ id: 'g1', chats: ['gc1'] }],
                };
                return values[url] as T;
            },
        };

        const inventory = await listLocalInventory(new Set<ItemType>([
            'settings', 'worldinfo', 'preset', 'theme', 'quickreply', 'persona',
            'character', 'chat', 'group', 'groupchat',
        ]), api);

        expect([...inventory.keys()].sort()).toEqual([
            'character/Alice.png',
            'chat/Alice.png/chat-1',
            'group/g1',
            'groupchat/gc1',
            'persona/me.png',
            'preset/instruct/Instruction',
            'preset/kobold/K',
            'quickreply/QR',
            'settings/root',
            'theme/Dark',
            'worldinfo/Lore',
        ]);
        expect(calls).not.toContain('/api/chats/get');
        expect(calls.every(url => !url.startsWith('/characters/'))).toBe(true);
    });

    it('calls only endpoints required by enabled scopes', async () => {
        const calls: string[] = [];
        const api: InventoryApi = {
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
