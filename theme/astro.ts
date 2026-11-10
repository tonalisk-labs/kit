// What a site's astro.config uses at build time: its font, its colour themes, Starlight's CSP and
// scrollable tables, and the sitemap's dates.
export { type FontChoice, siteFont } from './fonts/index.ts';
export { sitesTheme } from './themes/integration.ts';
export { starlightCsp } from './starlight/csp.ts';
export { scrollableTables } from './starlight/tables.ts';
export { datedBy, lastChanged } from './sitemap.ts';
