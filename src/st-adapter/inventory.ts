import type { ItemType } from '../sync-core/types';
import { mapPool } from '../util/pool';
import { listCharacterAssetRefs } from './character-assets';
import { stFetchJson } from './http';

export interface InventoryApi {
    head(url: string): Promise<boolean>;
    getJson<T>(url: string): Promise<T>;
    postJson<T>(url: string, body?: unknown): Promise<T>;
}

const defaultApi: InventoryApi = {
    async head(url: string): Promise<boolean> {
        const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        if (response.status === 404) return false;
        if (!response.ok) throw new Error(`HEAD ${url} failed: ${response.status}`);
        return true;
    },
    async getJson<T>(url: string): Promise<T> {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
        return response.json() as Promise<T>;
    },
    postJson: (url, body) => stFetchJson(url, body),
};

function add(
    output: Map<string, ItemType>,
    allowedTypes: ReadonlySet<ItemType>,
    type: ItemType,
    suffix: string,
): void {
    if (allowedTypes.has(type) && suffix) output.set(`${type}/${suffix}`, type);
}

export async function listLocalInventory(
    allowedTypes: ReadonlySet<ItemType>,
    api: InventoryApi = defaultApi,
): Promise<Map<string, ItemType>> {
    const output = new Map<string, ItemType>();
    const settingsTypes: ItemType[] = [
        'settings',
        'extension',
        'worldinfo',
        'preset',
        'theme',
        'quickreply',
        'persona',
    ];

    if (settingsTypes.some(type => allowedTypes.has(type))) {
        const raw = await api.postJson<Record<string, unknown>>('/api/settings/get', {});
        if (allowedTypes.has('settings')) output.set('settings/root', 'settings');
        for (const name of (raw.world_names as string[] | undefined) ?? []) {
            add(output, allowedTypes, 'worldinfo', name);
        }
        for (const theme of (raw.themes as Array<{ name?: string }> | undefined) ?? []) {
            add(output, allowedTypes, 'theme', theme.name ?? '');
        }
        for (const quickReply of (raw.quickReplyPresets as Array<{ name?: string }> | undefined) ?? []) {
            add(output, allowedTypes, 'quickreply', quickReply.name ?? '');
        }

        const settings = JSON.parse(typeof raw.settings === 'string' ? raw.settings : '{}') as Record<string, unknown>;
        const power = settings.power_user as { personas?: Record<string, unknown> } | undefined;
        for (const avatarId of Object.keys(power?.personas ?? {})) {
            add(output, allowedTypes, 'persona', avatarId);
        }

        const arrayPresetSources = [
            ['kobold', 'koboldai_setting_names'],
            ['novel', 'novelai_setting_names'],
            ['openai', 'openai_setting_names'],
            ['textgenerationwebui', 'textgenerationwebui_preset_names'],
        ] as const;
        for (const [apiId, key] of arrayPresetSources) {
            for (const name of (raw[key] as string[] | undefined) ?? []) {
                add(output, allowedTypes, 'preset', `${apiId}/${name}`);
            }
        }
        for (const apiId of ['instruct', 'context', 'sysprompt', 'reasoning'] as const) {
            for (const preset of (raw[apiId] as Array<{ name?: string }> | undefined) ?? []) {
                if (preset.name) add(output, allowedTypes, 'preset', `${apiId}/${preset.name}`);
            }
        }

        if (allowedTypes.has('extension')) {
            const discovered = await api.getJson<Array<{ name?: string; type?: string }>>('/api/extensions/discover');
            for (const extension of Array.isArray(discovered) ? discovered : []) {
                if (!extension.name?.startsWith('third-party/')) continue;
                const name = extension.name.slice('third-party/'.length);
                const version = await api.postJson<{ remoteUrl?: string }>('/api/extensions/version', {
                    extensionName: name,
                    global: extension.type === 'global',
                });
                if (version.remoteUrl) add(output, allowedTypes, 'extension', name);
            }
        }
    }

    if (
        allowedTypes.has('character')
        || allowedTypes.has('characterstate')
        || allowedTypes.has('characterasset')
        || allowedTypes.has('chat')
    ) {
        const characters = await api.postJson<Array<{ avatar?: string; name?: string }>>('/api/characters/all', {});
        const characterList = Array.isArray(characters) ? characters : [];
        const assetRefs = allowedTypes.has('characterasset')
            ? await mapPool(characterList, 4, async character => {
                if (!character.avatar) return [];
                const characterName = character.name || character.avatar.replace(/\.png$/i, '');
                return listCharacterAssetRefs(characterName, {
                    getJson: url => api.getJson(url),
                    postJson: url => api.postJson(url, {}),
                    getBytes: async () => {
                        throw new Error('Inventory must not download character asset bodies');
                    },
                });
            })
            : characterList.map(() => []);
        for (let index = 0; index < characterList.length; index += 1) {
            const character = characterList[index];
            if (!character.avatar) continue;
            add(output, allowedTypes, 'character', character.avatar);
            add(output, allowedTypes, 'characterstate', character.avatar);
            for (const ref of assetRefs[index]) output.set(ref.id, ref.type);
            if (!allowedTypes.has('chat')) continue;
            const chats = await api.postJson<Array<{ file_id?: string; file_name?: string }>>(
                '/api/characters/chats',
                { avatar_url: character.avatar },
            );
            for (const chat of Array.isArray(chats) ? chats : []) {
                const chatId = chat.file_id ?? chat.file_name?.replace(/\.jsonl$/i, '');
                if (chatId) add(output, allowedTypes, 'chat', `${character.avatar}/${chatId}`);
            }
        }
    }

    if (allowedTypes.has('group') || allowedTypes.has('groupchat') || allowedTypes.has('userimage')) {
        const groups = await api.postJson<Array<{
            id?: string;
            chats?: string[];
            avatar_url?: string;
        }>>('/api/groups/all', {});
        const groupList = Array.isArray(groups) ? groups : [];
        const presentUserImages = new Set<string>();
        if (allowedTypes.has('userimage')) {
            const imageUrls = [...new Set(groupList
                .map(group => group.avatar_url)
                .filter((url): url is string => Boolean(url?.startsWith('/user/images/'))))];
            const presence = await mapPool(imageUrls, 12, async url => ({
                url,
                present: await api.head(url),
            }));
            for (const result of presence) {
                if (result.present) presentUserImages.add(result.url);
            }
        }
        for (const group of groupList) {
            if (group.id) add(output, allowedTypes, 'group', group.id);
            if (group.avatar_url && presentUserImages.has(group.avatar_url)) {
                add(
                    output,
                    allowedTypes,
                    'userimage',
                    decodeURIComponent(group.avatar_url.slice('/user/images/'.length)),
                );
            }
            for (const chatId of group.chats ?? []) {
                add(output, allowedTypes, 'groupchat', chatId);
            }
        }
    }

    return output;
}
