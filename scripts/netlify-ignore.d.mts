/** Whether Netlify holds this build back for CI, and why, in a line for the build log. The runtime is netlify-ignore.mjs. */
export declare function gate(env: Record<string, string | undefined>): { skip: boolean; why: string }
