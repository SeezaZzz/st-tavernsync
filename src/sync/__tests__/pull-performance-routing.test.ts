import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('routes a device-local Pull profile through UI and engine with mobile fallback', () => {
    const index = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    const engine = readFileSync(new URL('../engine.ts', import.meta.url), 'utf8');
    expect(index).toContain('promptPullPerformanceChoice');
    expect(index).toContain('promptPullPerformanceFallback');
    expect(index).toContain('pullPerformanceProfile: selected');
    expect(engine).toContain('pullPerformanceProfile?: PullPerformanceProfile');
    expect(engine).toContain('profile: options.pullPerformanceProfile');
});

it('keeps non-interactive Pulls prompt-free and reloads after a successful mobile resume', () => {
    const index = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    expect(index).toContain('async function handlePull(interactive = true)');
    expect(index).toContain('await handlePull(false)');
    expect(index).toContain('offerFastPullReload(message)');
    expect(index.match(/offerFastPullReload\(message\)/g)).toHaveLength(2);
});
