// The shared looks as Tailwind utility lists, each light look with its dark. A busy button
// (aria-busy) shows a spinner before its label, and a disabled one is grey whatever its tone.
const BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-full transition duration-150 ease-out pointer-coarse:min-h-11 disabled:cursor-not-allowed disabled:bg-none disabled:shadow-none disabled:bg-slate-200 disabled:text-slate-600 dark:disabled:bg-slate-800 dark:disabled:text-slate-400 aria-busy:before:size-4 aria-busy:before:animate-spin aria-busy:before:rounded-full aria-busy:before:border-2 aria-busy:before:border-current aria-busy:before:border-r-transparent';
// The sheen fades out above the label, and light mode presses darker: white text keeps AA on
// every theme's primary, whose 500 step clears 4.5:1 in dark mode alone.
const BUTTON_TONES = {
  primary:
    'bg-primary-600 bg-linear-to-b from-white/10 to-transparent to-25% text-white shadow-sm inset-shadow-2xs inset-shadow-white/25 not-disabled:hover:bg-primary-700 not-disabled:active:bg-primary-800 not-disabled:active:shadow-none dark:not-disabled:hover:bg-primary-500 dark:not-disabled:active:bg-primary-700',
  light:
    'bg-white text-slate-900 shadow-xs ring-1 ring-inset ring-slate-300 not-disabled:hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-50 dark:ring-slate-700 dark:not-disabled:hover:bg-slate-800',
  ghost:
    'text-slate-700 not-disabled:hover:bg-slate-200 dark:text-slate-300 dark:not-disabled:hover:bg-slate-800',
  danger:
    'bg-red-600 text-white shadow-sm not-disabled:hover:bg-red-700 not-disabled:active:bg-red-800 not-disabled:active:shadow-none',
  star: 'bg-accent-800 text-white shadow-sm not-disabled:hover:bg-accent-900 not-disabled:active:shadow-none dark:bg-accent-200 dark:text-slate-950 dark:not-disabled:hover:bg-accent-300',
} as const;
const BUTTON_SIZES = {
  lg: 'px-6 py-3 text-lg font-semibold',
  md: 'px-4 py-2 font-medium',
  sm: 'px-3 py-1.5 font-medium',
  xs: 'px-2 py-1 text-sm font-medium',
} as const;

export type ButtonTone = keyof typeof BUTTON_TONES;
export type ButtonSize = keyof typeof BUTTON_SIZES;

/** A button, or a link that looks like one. */
export const button = (tone: ButtonTone, size: ButtonSize = 'md'): string =>
  `${BUTTON} ${BUTTON_TONES[tone]} ${BUTTON_SIZES[size]}`;

export const CARD =
  'rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-900/5 dark:bg-slate-900 dark:shadow-none dark:ring-white/10';
/** A card that is one link: it lifts on hover, or under reduced motion only deepens its shadow. */
export const CARD_LINK = `${CARD} transition duration-300 ease-out hover:shadow-lg motion-safe:hover:-translate-y-0.5`;

/** A surface over the page: a menu, a popover, a list of suggestions, a notice. */
export const FLOATING =
  'rounded-xl bg-white shadow-lg ring-1 ring-slate-900/5 dark:bg-slate-900 dark:ring-white/10';

// Dialogs, drawers and popovers are visible at rest and only their entry moves, so a browser that
// misses the transition still shows them whole. They close at once; under reduced motion, no move.
const ENTRY = 'motion-safe:transition motion-safe:duration-150 motion-safe:ease-out';

/** A native popover or dialog fades and grows in as it opens. Transforms leave its layout, and so
 *  its centring, alone. */
export const POPOVER_MOTION = `${ENTRY} starting:open:opacity-0 starting:open:scale-95`;
const BACKDROP =
  'backdrop:bg-slate-950/50 backdrop:backdrop-blur-xs motion-safe:backdrop:transition motion-safe:backdrop:duration-150 starting:open:backdrop:bg-transparent';

/** A modal dialog, centred both ways over a page it dims as it opens. */
export const DIALOG = `fixed inset-0 m-auto rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/5 dark:bg-slate-900 dark:ring-white/10 ${POPOVER_MOTION} ${BACKDROP}`;

const DRAWER_EDGES = {
  start: 'ltr:starting:open:-translate-x-full rtl:starting:open:translate-x-full',
  end: 'ltr:starting:open:translate-x-full rtl:starting:open:-translate-x-full',
} as const;

/** A modal drawer the full height of one edge, sliding in over a page it dims. */
export const drawer = (edge: keyof typeof DRAWER_EDGES): string =>
  `fixed inset-y-0 bg-white shadow-2xl dark:bg-slate-900 ${ENTRY} ${DRAWER_EDGES[edge]} ${BACKDROP}`;

// Tight tracking suits text-xl and larger only; balanced lines keep a short title from ending on
// one word.
export const DISPLAY = 'text-4xl font-bold tracking-tight text-balance sm:text-5xl';
export const HEADING = 'text-2xl font-bold tracking-tight text-balance sm:text-3xl';
export const LEAD = 'text-lg/relaxed text-pretty text-slate-700 dark:text-slate-300';

export const BADGE =
  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-sm font-medium ring-1 ring-inset';
// Grey for plain facts; secondary and accent take the theme's own scales, at 6.3:1 or more.
export const BADGE_TONES = {
  grey: 'bg-slate-200 ring-slate-500/20 dark:bg-slate-800 dark:ring-white/10',
  secondary:
    'bg-secondary-100 text-secondary-800 ring-secondary-700/20 dark:bg-secondary-800 dark:text-secondary-100 dark:ring-white/10',
  accent:
    'bg-accent-100 text-accent-800 ring-accent-700/20 dark:bg-accent-900 dark:text-accent-200 dark:ring-white/10',
} as const;

/** The track that holds a segmented choice's options. */
export const SEGMENT_GROUP = 'inline-flex gap-1 rounded-full bg-slate-100 p-1 dark:bg-slate-800';
// One option of a segmented choice. The chosen one stands at 3:1 against the track in every theme,
// a step lighter in dark mode.
export const SEGMENT =
  'group relative flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium pointer-coarse:min-h-11 text-slate-600 hover:not-has-checked:bg-slate-200 has-checked:bg-primary-600 has-checked:text-white dark:text-slate-400 dark:hover:not-has-checked:bg-slate-700 dark:has-checked:bg-primary-500';
// The option's native radio, unpainted over its whole label, so arrows move between options and
// its focus ring is the option's own (inside, white, once chosen).
export const SEGMENT_INPUT =
  'absolute inset-0 cursor-pointer appearance-none rounded-full checked:-outline-offset-2 checked:outline-white';
