/** Every app icon PNG drawn from public/icon.svg: where it goes and its square size in pixels. */
export declare const ICONS: { file: string; size: number }[]
/** An 8-bit RGB PNG (colour type 2) from RGBA pixels, the alpha dropped: App Store Connect refuses an icon with one. */
export declare function rgbPng(size: number, rgba: Uint8Array): Buffer
