// Types for writeas.mjs. The runtime is writeas.mjs.

export type RestRequest = (path: string, init: RequestInit) => Promise<Response>

export type WriteAsOutcome = { ok: true; rejected: string[]; stale: string[]; gone: string[]; owned: boolean } | { ok: false; why: string }

export declare function serviceRequest(path: string, init?: RequestInit): Promise<Response>
export declare function handOver(ownerId: string, id: string, opts?: { request?: RestRequest }): Promise<boolean>
export declare function writeAs(ownerId: string, items: Record<string, unknown>[], opts?: { handOver?: boolean; request?: RestRequest }): Promise<WriteAsOutcome>
