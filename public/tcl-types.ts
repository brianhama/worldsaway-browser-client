/** Models crossing the Tcl worker/browser boundary. Programs remain strings and
 * callbacks return to Tcl; this module contains no JavaScript evaluation. */
import type { WorldState, WorldObject, WireFields, ApiRequest } from './types.js';
import type { NativeImage, NativeChoreCommand, ColorPalette, WorldRenderer } from './renderer.js';
import type { WorldAudio } from './audio.js';
export interface TclContext {
    taskId?: string | number | null;
    [key: string]: any;
}
/** Either a retained Tcl program or a native message invocation; neither form
 * is executable JavaScript in the browser. */
export interface TclCallback {
    script?: string;
    command?: {
        noid: number;
        id: number;
        fields: WireFields;
    };
}
export interface TclListItem {
    id: number;
    text: string;
    enabled: boolean;
    callback: TclCallback | null;
}
export interface TclControl {
    id: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    value: any;
    callback: TclCallback | null;
    context: TclContext;
    enabled: boolean;
    visible: boolean;
    default: boolean;
    escape: boolean;
    group: string | null;
    items: TclListItem[];
    selected: number;
    maxLength: number;
    columns?: number[];
    password?: boolean;
    graphic?: NativeGraphicReference;
}
export interface TclDialog {
    id: string;
    title: string;
    width: number;
    height: number;
    style: string;
    context: TclContext;
    visible: boolean;
    made: boolean;
    controls: TclControl[];
    closed?: false;
}
/** Closed updates are tombstones: no stale control model is required to remove
 * a dialog after cancellation or a world reset. */
export type TclDialogUpdate = TclDialog | {
    id: string;
    closed: true;
};
/** An admitted image/cel/frame reference behind a browser CEL handle, rather
 * than a native process pointer or an instruction to load an executable. */
export interface NativeGraphicReference {
    image?: NativeImage;
    objectNoid?: number;
    imageURL?: string;
    imageVersion?: number;
    resourceId?: number;
    imageDefault?: number;
    celIndex?: number;
    frameIndex?: number;
    graphicState?: number;
    orientation?: number;
    mood?: number;
    colorMap?: number[];
    masterPalette?: ColorPalette;
}
export interface TclChore {
    name: string;
    noid: number;
    index: number;
    endState: string;
    endChore: string;
    commands: NativeChoreCommand[];
    imageState: number;
}
/** Shared by a queued chore and its timers, so cancellation interrupts both
 * work waiting for its turn and work already inside an awaited delay. */
export interface TclCancellation {
    taskId: string | number | null;
    cancelled: boolean;
}
export interface TclChoreJob {
    noid: number;
    token: TclCancellation;
    tail: Promise<any> | null;
    rejectCancel: ((reason: unknown) => void) | null;
    active: boolean;
}
export interface TclTimer {
    timer: ReturnType<typeof setTimeout> | null;
    reject: (reason: unknown) => void;
    taskId?: string | number | null;
    token?: TclCancellation;
}
export interface TclVisualHostOptions {
    getState?: () => WorldState;
    renderer?: WorldRenderer;
    audio?: Pick<WorldAudio, 'play'>;
    getImage?: (object: WorldObject) => NativeImage | Promise<NativeImage>;
    fetchResource?: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>;
    onChange?: () => void;
    onBalloon?: (event: {
        noid: number;
        text: string;
        type: number;
        until: number;
    }) => void;
    onDialog?: (model: TclDialogUpdate) => void;
    onCallback?: (event: any) => any;
    onError?: (error: any) => void;
    now?: () => number;
    frameTime?: number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
}
export interface WorldTclOptions {
    api: ApiRequest;
    getState: () => WorldState;
    renderer?: WorldRenderer;
    audio?: Pick<WorldAudio, 'play'>;
    onChange?: () => void;
    onMessage?: (entry: any) => void;
    onError?: (error: any) => void;
}
