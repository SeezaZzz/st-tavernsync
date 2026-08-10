import type { PullPerformanceProfile } from '../backend/drive/pull-performance-profile';

export interface PullPerformanceChoice {
    readonly profile: PullPerformanceProfile;
    readonly remember: boolean;
}

export function buildPullPerformanceChoiceModel(recommended: PullPerformanceProfile) {
    return { selected: recommended, remember: true, options: ['mobile', 'pc'] as const };
}

export type PullPerformanceFallbackAction = PullPerformanceProfile | 'cancel';

export function buildPullPerformanceFallbackModel() {
    return { selected: 'mobile' as const, options: ['mobile', 'pc', 'cancel'] as const };
}

export async function promptPullPerformanceChoice(
    recommended: PullPerformanceProfile,
): Promise<PullPerformanceChoice | null> {
    const root = document.createElement('div');
    root.className = 'tavernsync-pull-performance-choice';
    root.innerHTML = `
        <p><strong>Choose Pull performance</strong></p>
        <label><input type="radio" name="tavernsync_pull_profile" value="mobile" ${recommended === 'mobile' ? 'checked' : ''}> <b>Mobile / Stable</b><br><small>Best for phones and tablets. Uses fewer simultaneous requests.</small></label>
        <label><input type="radio" name="tavernsync_pull_profile" value="pc" ${recommended === 'pc' ? 'checked' : ''}> <b>PC / Fast</b><br><small>Best for desktop. May overload some mobile WebViews.</small></label>
        <label><input type="checkbox" name="tavernsync_remember_profile" checked> Remember for this device</label>`;
    const context = SillyTavern.getContext() as SillyTavernContext & {
        callGenericPopup?: (content: HTMLElement, type?: number) => Promise<unknown>;
        POPUP_TYPE?: { readonly CONFIRM?: number };
    };
    if (typeof context.callGenericPopup !== 'function') return null;
    const accepted = await context.callGenericPopup(root, context.POPUP_TYPE?.CONFIRM ?? 1);
    if (!accepted) return null;
    const selected = root.querySelector<HTMLInputElement>('input[name="tavernsync_pull_profile"]:checked');
    const remember = root.querySelector<HTMLInputElement>('input[name="tavernsync_remember_profile"]');
    if (selected?.value !== 'mobile' && selected?.value !== 'pc') return null;
    return { profile: selected.value, remember: !!remember?.checked };
}

export async function promptPullPerformanceFallback(): Promise<PullPerformanceFallbackAction> {
    const root = document.createElement('div');
    root.className = 'tavernsync-pull-performance-fallback';
    root.innerHTML = `
        <p><strong>PC / Fast could not finish on this device</strong></p>
        <label><input type="radio" name="tavernsync_pull_fallback" value="mobile" checked> <b>Switch to Mobile / Stable and resume</b><br><small>Continue from the existing checkpoint with fewer simultaneous requests.</small></label>
        <label><input type="radio" name="tavernsync_pull_fallback" value="pc"> <b>Keep PC / Fast</b><br><small>Stop this Pull and keep the current profile for next time.</small></label>
        <label><input type="radio" name="tavernsync_pull_fallback" value="cancel"> <b>Cancel</b><br><small>Stop without changing the saved profile.</small></label>`;
    const context = SillyTavern.getContext() as SillyTavernContext & {
        callGenericPopup?: (content: HTMLElement, type?: number) => Promise<unknown>;
        POPUP_TYPE?: { readonly CONFIRM?: number };
    };
    if (typeof context.callGenericPopup !== 'function') return 'cancel';
    const accepted = await context.callGenericPopup(root, context.POPUP_TYPE?.CONFIRM ?? 1);
    if (!accepted) return 'cancel';
    const selected = root.querySelector<HTMLInputElement>('input[name="tavernsync_pull_fallback"]:checked');
    return selected?.value === 'mobile' || selected?.value === 'pc' ? selected.value : 'cancel';
}
