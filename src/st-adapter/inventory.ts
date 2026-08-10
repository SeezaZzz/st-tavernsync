import type { ItemType } from '../sync-core/types';
import { stFetchJson } from './http';

export interface InventoryApi {
    postJson<T>(url: string, body?: unknown): Promise<T>;
}

const defaultApi: InventoryApi = {
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
    }

    if (allowedTypes.has('character') || allowedTypes.has('chat')) {
        const characters = await api.postJson<Array<{ avatar?: string }>>('/api/characters/all', {});
        for (const character of Array.isArray(characters) ? characters : []) {
            if (!character.avatar) continue;
            add(output, allowedTypes, 'character', character.avatar);
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

    if (allowedTypes.has('group') || allowedTypes.has('groupchat')) {
        const groups = await api.postJson<Array<{ id?: string; chats?: string[] }>>('/api/groups/all', {});
        for (const group of Array.isArray(groups) ? groups : []) {
            if (group.id) add(output, allowedTypes, 'group', group.id);
            for (const chatId of group.chats ?? []) {
                add(output, allowedTypes, 'groupchat', chatId);
            }
        }
    }

    return output;
}
