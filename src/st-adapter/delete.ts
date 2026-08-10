import type { ItemType } from '../sync-core/types';
import { stFetchDelete, stFetchJson } from './http';
import { decodeCharacterAssetId } from './character-assets';
import { writeSettings } from './write';

const MISSING_STATUSES = [400, 404] as const;

export async function deleteLocalItem(id: string, type: ItemType): Promise<void> {
    const [, ...parts] = id.split('/');

    switch (type) {
        case 'settings':
            throw new Error('settings snapshot cannot be deleted');
        case 'worldinfo':
            await stFetchDelete('/api/worldinfo/delete', { name: parts.join('/') }, MISSING_STATUSES);
            return;
        case 'preset': {
            const [apiId, ...nameParts] = parts;
            await stFetchDelete('/api/presets/delete', {
                apiId,
                name: nameParts.join('/'),
            }, MISSING_STATUSES);
            return;
        }
        case 'theme':
            await stFetchDelete('/api/themes/delete', { name: parts.join('/') }, MISSING_STATUSES);
            return;
        case 'quickreply':
            await stFetchDelete('/api/quick-replies/delete', { name: parts.join('/') }, MISSING_STATUSES);
            return;
        case 'character':
            await stFetchDelete('/api/characters/delete', {
                avatar_url: parts.join('/'),
                delete_chats: false,
            }, MISSING_STATUSES);
            return;
        case 'characterasset': {
            const { characterName, relativePath } = decodeCharacterAssetId(id);
            const pathParts = relativePath.split('/');
            const filename = pathParts.pop();
            if (!filename) throw new Error(`Character asset is missing a filename: ${id}`);
            const spriteName = filename.replace(/\.[^.]+$/, '');
            await stFetchDelete('/api/sprites/delete', {
                name: [characterName, ...pathParts].join('/'),
                label: spriteName,
                spriteName,
            }, MISSING_STATUSES);
            return;
        }
        case 'chat': {
            const [avatarUrl, ...chatParts] = parts;
            await stFetchDelete('/api/chats/delete', {
                avatar_url: avatarUrl,
                chatfile: chatParts.join('/'),
            }, MISSING_STATUSES);
            return;
        }
        case 'group':
            await stFetchDelete('/api/groups/delete', { id: parts.join('/') }, MISSING_STATUSES);
            return;
        case 'groupchat':
            await stFetchDelete('/api/chats/group/delete', { id: parts.join('/') }, MISSING_STATUSES);
            return;
        case 'userimage':
            await stFetchDelete('/api/images/delete', {
                path: `user/images/${parts.join('/')}`,
            }, MISSING_STATUSES);
            return;
        case 'characterstate':
        case 'extension':
            return;
        case 'persona':
            await deletePersona(parts.join('/'));
            return;
    }
}

async function deletePersona(avatarId: string): Promise<void> {
    const raw = await stFetchJson<{ settings: string }>('/api/settings/get', {});
    const settings = JSON.parse(raw.settings || '{}') as Record<string, unknown>;
    const power = settings.power_user && typeof settings.power_user === 'object'
        ? settings.power_user as Record<string, unknown>
        : {};
    const personas = power.personas && typeof power.personas === 'object'
        ? power.personas as Record<string, unknown>
        : {};
    const descriptions = power.persona_descriptions && typeof power.persona_descriptions === 'object'
        ? power.persona_descriptions as Record<string, unknown>
        : {};

    delete personas[avatarId];
    delete descriptions[avatarId];
    power.personas = personas;
    power.persona_descriptions = descriptions;
    settings.power_user = power;

    await writeSettings(settings);
    await stFetchDelete('/api/avatars/delete', { avatar: avatarId }, MISSING_STATUSES);
}
