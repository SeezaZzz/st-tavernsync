import { describe, expect, it } from 'vitest';

import type { DriveV2ChoiceInput } from '../../backend/drive/drive-v2-choice';
import { buildDriveV2ChoiceModel } from '../drive-v2-source-choice';

function choiceFixture(): DriveV2ChoiceInput {
    return {
        local: { device: 'Zzz_pc', itemCount: 2347 },
        heads: [{
            commitId: 'phone-head',
            device: 'Zzz_iPhone',
            createdTime: '2026-08-09T12:00:00Z',
            itemCount: 2350,
            useDrive: { add: 4, replace: 5, delete: 3, inSync: 2338 },
            useLocal: { add: 1, replace: 5, delete: 4, inSync: 2338 },
        }],
    };
}

describe('Drive v2 source choice model', () => {
    it('creates one unselected action per head plus local and cancel', () => {
        const model = buildDriveV2ChoiceModel(choiceFixture());
        expect(model.actions.map(action => action.choice)).toEqual([
            { kind: 'drive', commitId: 'phone-head' },
            { kind: 'local' },
            { kind: 'cancel' },
        ]);
        expect(model.actions.map(action => action.id)).toEqual([
            'drive:phone-head',
            'local',
            'cancel',
        ]);
        expect(model.actions[0].detail).toContain('2026-08-09T12:00:00Z');
        expect(model.actions[0].detail).toContain('+4 ~5 −3');
        expect(model.actions[1].detail).toContain('Zzz_iPhone: +1 ~5 −4');
        expect(model.selectedActionId).toBeNull();
    });
});
