// Types for peers.mjs. The runtime is peers.mjs.

type Rest = (path: string, init?: RequestInit) => Promise<unknown>

/** userId -> the owner ids whose records that user may see. */
export declare function buildPeerMap(rest: Rest): Promise<Map<string, Set<string>>>
