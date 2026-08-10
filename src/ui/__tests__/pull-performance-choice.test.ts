import { describe, expect, it } from 'vitest';

import {
    buildPullPerformanceChoiceModel,
    buildPullPerformanceFallbackModel,
} from '../pull-performance-choice';

describe('Pull performance chooser', () => {
    it('preselects the recommended profile and defaults to remembering it', () => {
        expect(buildPullPerformanceChoiceModel('mobile')).toEqual({
            selected: 'mobile', remember: true,
            options: ['mobile', 'pc'],
        });
        expect(buildPullPerformanceChoiceModel('pc').selected).toBe('pc');
    });

    it('offers switch, keep, and cancel after a PC WebView failure', () => {
        expect(buildPullPerformanceFallbackModel()).toEqual({
            selected: 'mobile',
            options: ['mobile', 'pc', 'cancel'],
        });
    });
});
