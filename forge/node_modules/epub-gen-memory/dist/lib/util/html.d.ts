import type { EPub } from '..';
export type CB = typeof imgSrc;
export type Image = {
    url: string;
    id: string;
    extension: string | null;
    mediaType: string | null;
};
declare function imgSrc(this: EPub, url: string): string;
export declare function normalizeHTML(this: EPub, index: number, data: string): string;
export {};
