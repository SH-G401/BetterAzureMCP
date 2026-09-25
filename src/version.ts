declare const __VERSION__: string | undefined;

/** Package version, injected at build time by scripts/build.mjs. */
export const VERSION: string = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

export const SERVER_NAME = 'betterazuremcp';
