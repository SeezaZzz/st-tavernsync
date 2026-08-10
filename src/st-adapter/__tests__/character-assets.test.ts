import { describe, expect, it } from 'vitest';

import {
    characterAssetId,
    decodeCharacterAssetId,
    listCharacterAssetRefs,
    listCharacterAssets,
    type CharacterAssetApi,
} from '../character-assets';

describe('character assets', () => {
    it('lists and reads expression images and character BGM through existing ST APIs', async () => {
        const bytesByPath = new Map([
            ['/characters/Aqua/joy.gif?t=1', new Uint8Array([1, 2])],
            ['/characters/Aqua/bgm/battle.ogg', new Uint8Array([3, 4, 5])],
        ]);
        const api: CharacterAssetApi = {
            async getJson<T>(url: string): Promise<T> {
                expect(url).toBe('/api/sprites/get?name=Aqua');
                return [{ path: '/characters/Aqua/joy.gif?t=1' }] as T;
            },
            async postJson<T>(url: string): Promise<T> {
                expect(url).toBe('/api/assets/character?name=Aqua&category=bgm');
                return ['/characters/Aqua/bgm/battle.ogg'] as T;
            },
            async getBytes(url: string): Promise<Uint8Array> {
                return bytesByPath.get(url) ?? new Uint8Array();
            },
        };

        const assets = await listCharacterAssets('Aqua', api);

        expect(assets.map(value => [value.item.id, value.item.type, value.bytes.byteLength])).toEqual([
            ['characterasset/Aqua/joy.gif', 'characterasset', 2],
            ['characterasset/Aqua/bgm/battle.ogg', 'characterasset', 3],
        ]);
    });

    it('round-trips Unicode, spaces and dots without exposing path separators', () => {
        const id = characterAssetId('เมือง ลามก.1', 'bgm/surprise 01.ogg');
        expect(decodeCharacterAssetId(id)).toEqual({
            characterName: 'เมือง ลามก.1',
            relativePath: 'bgm/surprise 01.ogg',
        });
    });

    it('lists inventory references without downloading asset bodies', async () => {
        const downloaded: string[] = [];
        const api: CharacterAssetApi = {
            async getJson<T>(): Promise<T> {
                return [{ path: '/characters/Aqua/joy.gif?t=1' }] as T;
            },
            async postJson<T>(): Promise<T> {
                return ['/characters/Aqua/bgm/battle.ogg'] as T;
            },
            async getBytes(url: string): Promise<Uint8Array> {
                downloaded.push(url);
                return new Uint8Array();
            },
        };

        await expect(listCharacterAssetRefs('Aqua', api)).resolves.toEqual([
            { id: 'characterasset/Aqua/joy.gif', type: 'characterasset' },
            { id: 'characterasset/Aqua/bgm/battle.ogg', type: 'characterasset' },
        ]);
        expect(downloaded).toEqual([]);
    });
});
