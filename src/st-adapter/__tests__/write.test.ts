import { beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({
    postJson: vi.fn(async () => undefined),
    postForm: vi.fn(async () => ({ file_name: 'unused', path: 'unused' })),
}));

vi.mock('../http', () => ({
    stFetchJson: http.postJson,
    stFetchForm: http.postForm,
}));

import type { ItemType } from '../../sync-core/types';
import { applyLocalItem } from '../write';

describe('scoped restore writers', () => {
    beforeEach(() => {
        http.postJson.mockClear();
        http.postForm.mockClear();
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
});
