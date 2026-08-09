import type { DriveV2ChoiceInput } from '../backend/drive/drive-v2-choice';
import type { DriveV2SourceChoice } from '../backend/drive/drive-v2-sync';

export interface DriveV2ChoiceAction {
    readonly id: string;
    readonly label: string;
    readonly detail: string;
    readonly choice: DriveV2SourceChoice;
}

export interface DriveV2ChoiceModel {
    readonly actions: readonly DriveV2ChoiceAction[];
    readonly selectedActionId: string | null;
}

export function buildDriveV2ChoiceModel(input: DriveV2ChoiceInput): DriveV2ChoiceModel {
    const driveActions = input.heads.map(head => ({
        id: `drive:${head.commitId}`,
        label: `Use Drive snapshot from ${head.device}`,
        detail: `${head.createdTime || 'time unknown'} · ${head.itemCount} items · +${head.useDrive.add} ~${head.useDrive.replace} −${head.useDrive.delete}`,
        choice: { kind: 'drive' as const, commitId: head.commitId },
    }));
    const localEffects = input.heads.map(head =>
        `${head.device}: +${head.useLocal.add} ~${head.useLocal.replace} −${head.useLocal.delete}`,
    ).join(' · ');
    return {
        actions: [
            ...driveActions,
            {
                id: 'local',
                label: `Make ${input.local.device} latest`,
                detail: `${input.local.itemCount} items · ${localEffects || 'new Drive snapshot'} · includes local deletions`,
                choice: { kind: 'local' as const },
            },
            {
                id: 'cancel',
                label: 'Cancel',
                detail: 'Change nothing',
                choice: { kind: 'cancel' as const },
            },
        ],
        selectedActionId: null,
    };
}

export async function promptDriveV2SourceChoice(
    input: DriveV2ChoiceInput,
): Promise<DriveV2SourceChoice> {
    const model = buildDriveV2ChoiceModel(input);
    const root = document.createElement('div');
    root.className = 'tavernsync-drive-v2-choice';

    const heading = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = 'Choose which complete snapshot becomes current';
    heading.append(strong);
    root.append(heading);

    const warning = document.createElement('p');
    warning.textContent = 'The selected snapshot includes additions, replacements, and deletions.';
    root.append(warning);

    for (const action of model.actions) {
        const label = document.createElement('label');
        label.style.display = 'block';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'tavernsync_drive_v2_source';
        radio.value = action.id;
        label.append(radio, ` ${action.label} — ${action.detail}`);
        root.append(label);
    }

    const context = SillyTavern.getContext() as SillyTavernContext & {
        callGenericPopup?: (
            content: string | HTMLElement,
            type?: number,
            inputValue?: string,
            options?: Record<string, unknown>,
        ) => Promise<unknown>;
        POPUP_TYPE?: { readonly CONFIRM?: number };
    };
    if (typeof context.callGenericPopup !== 'function') return { kind: 'cancel' };

    const accepted = await context.callGenericPopup(
        root,
        context.POPUP_TYPE?.CONFIRM ?? 1,
    );
    if (!accepted) return { kind: 'cancel' };

    const selected = root.querySelector('input[name="tavernsync_drive_v2_source"]:checked');
    if (!(selected instanceof HTMLInputElement)) return { kind: 'cancel' };
    return model.actions.find(action => action.id === selected.value)?.choice ?? { kind: 'cancel' };
}
