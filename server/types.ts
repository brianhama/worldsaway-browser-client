/** Native schemas are supplied by each world; field names and values are dynamic. */
export type NativeFields = Record<string, any>;
export interface NativeObject {
  noid: number;
  classNumber: number;
  className?: string;
  fields: NativeFields;
}
export interface NativePacket { noid: number; id: number; payload: Buffer; }
/** Launcher-derived connection material; the one-time token is removed after login. */
export interface NativeConnection {
  host: string;
  worldPort: number;
  rpcPort: number;
  account: string;
  token?: string;
  avatar?: string;
  region?: number;
  worldName?: string;
  wsurl?: string | null;
  transport?: string;
  tunnelPrefix?: string;
  loginUrl?: string;
}
export interface LauncherInput {
  launcherUrl?: string;
  loginUrl?: string;
  account: string;
  password?: string;
  world?: string;
  avatar?: string;
  tunnel?: boolean;
}
export interface ResourceEntry { id: number; version: number; data: Buffer; }
export interface FileEntry { version: number; data: Buffer; requestedVersion?: number; }
export interface HistoryEntry extends NativeFields {
  seq: number; time: number; type: string; noid: number; id: number; messageId: number;
  fields: NativeFields; values: NativeFields;
}
/** Browser-facing state; socket handles and launcher credentials live outside this model. */
export interface SessionState extends NativeFields {
  status: string; avatar: string | null; avatars: {name: string; busy: boolean}[];
  capacity: number; actorNoid: number | null; helperName: string;
  objects: NativeObject[]; region: NativeObject | null; history: HistoryEntry[];
  resources: NativeFields & {received: number; total: number; bytes: number};
  revision: number; error: string | null;
}
/** Request-time context needed to interpret replies that omit the original arguments. */
export interface PendingRequest {
  noid: number; id: number; fields: NativeFields; replyId: number; time: number;
  actorNoid: number | null; handNoid?: number; before: NativeFields; seq?: number;
}
export interface NativeAction {
  noid: number; id?: number; messageId?: number; fields?: NativeFields; values?: NativeFields;
}
/** Inherited by async host calls so scene changes can reject stale continuations. */
export interface TclContext extends NativeFields {taskId?: string | null; self?: number; worldGeneration?: number;}
export interface TclMetadata {taskId?: string; signal?: AbortSignal;}
export type TclValue = unknown;
export type TclCommandHandler = (command: string, args: string[], context: TclContext, metadata: TclMetadata) => unknown | Promise<unknown>;
export interface TclExecutionOptions {
  globals?: NativeFields; context?: TclContext; background?: boolean; wallTimeoutMs?: number;
}
export interface TclRuntimeOptions {
  onCommand?: TclCommandHandler;
  onOutput?: (text: string, metadata: {channel: string; context: TclContext; taskId: string}) => void;
  executable?: string; commandLimit?: number; timeLimitMs?: number; wallTimeoutMs?: number;
  backgroundHostCallLimit?: number; maxOutputBytes?: number; maxScriptBytes?: number; maxTasks?: number;
}
export type TclPromise = Promise<string> & { readonly taskId: string };
/** Parent-process bookkeeping for one worker coroutine and its independent budgets. */
export interface TclTask {
 id: string; resolve: (value: string) => void; reject: (error: unknown) => void;
 context: TclContext; abort: AbortController; outputBytes: number; calls: number;
 timer: ReturnType<typeof setTimeout> | null; background: boolean; wallTimeoutMs: number;
 hostCallLimit: number; pendingCall?: string | null;
}
