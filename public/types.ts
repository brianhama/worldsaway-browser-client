/** Values supplied by native message descriptors and Tcl bindings. Field names
 * and value shapes are determined by the remote world's class catalog. */
export type WireFields = Record<string, any>;
export type Fields = WireFields;
/** Native object identity plus schema-defined fields; display projections may clone this shape. */
export interface WorldObject {
  noid: number;
  classNumber?: number;
  name?: string;
  fields: WireFields;
  [key: string]: any;
}
/** Session history ordering and optional request correlation supplied by the bridge. */
export interface RuntimeEvent {
  seq: number;
  type: string;
  id?: number;
  messageId?: number;
  noid?: number;
  requestId?: number;
  requestNoid?: number;
  requestSeq?: number;
  fields?: WireFields;
  values?: WireFields;
  [key: string]: any;
}
export type WorldEvent = RuntimeEvent;
/** Snapshots also represent disconnected/bootstrap states, so scene fields are optional. */
export interface WorldState {
  status?: string;
  actorNoid?: number | null;
  objects?: WorldObject[];
  region?: WorldObject | null;
  history?: RuntimeEvent[];
  avatar?: string;
  worldName?: string;
  permissions?: {flags?: number; [key: string]: any};
  [key: string]: any;
}
/** Native receiver and fields, or a browser command requiring preparation before dispatch. */
export interface ActionRequest {
  id?: number;
  messageId?: number;
  noid?: number;
  fields?: WireFields;
  values?: WireFields;
  command?: string;
  [key: string]: any;
}
export interface WireField {
  name: string;
  type: string;
  width: number;
  count: number | string | null;
  min: number;
  max: number;
  scope: string;
  wire: boolean;
  descriptor: string;
  label: string;
  hidden: boolean;
  default: any;
  options?: readonly {value: string | number; label: string}[] | null;
}
/** Catalog metadata drives forms and receiver selection; it is not an authorization grant. */
export interface ActionDescriptor {
  id: number;
  messageId: number;
  name: string;
  label: string;
  classes: readonly number[];
  schema: string;
  fields: readonly WireField[];
  replyId: number | null;
  category: string;
  danger: boolean;
  destructive: boolean;
  admin: boolean;
  hints: string;
  receiver: string;
  sourceCalls: number;
  shared: boolean;
  evidence: string;
  [key: string]: any;
}
/** Controllers receive the raw bridge API so preparatory requests cannot recurse into themselves. */
export type ApiRequest = (path: string, data?: any) => Promise<any>;
export type StateProvider = () => WorldState;
export interface ControllerOptions {
  api?: ApiRequest;
  getState?: StateProvider;
  stateProvider?: StateProvider;
  onError?: (error: any) => void;
  timeout?: number;
}
/** Shared waiter storage. `after` excludes old history; request sequence tags, when
 * present, distinguish separate submissions of the same native request. */
export interface PendingReply {
  id: number;
  noid?: number;
  reply?: number;
  replyId?: number;
  requestId?: number;
  requestSeq?: number | null;
  after: number;
  resolve: (value: WireFields) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout> | null;
}
