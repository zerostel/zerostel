declare const __VERSION__: string | undefined;
declare const __STANDALONE__: boolean | undefined;

export const VERSION: string = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

/** Built as a single executable with Node inside (scripts/standalone.mjs), rather than run by an installed Node. */
export const STANDALONE: boolean = typeof __STANDALONE__ === 'boolean' && __STANDALONE__;
