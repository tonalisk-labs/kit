import catalogue from './themes.json' with { type: 'json' };

type Role = 'primary' | 'secondary' | 'accent';
type Step = '50' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | '950';

interface SourceColour {
  readonly name: string;
  readonly hex: string;
  readonly model: string;
  readonly flaggedOutOfGamut: boolean;
}

interface RoleChoice {
  readonly hex: string;
  /** The palette colour the role takes, or undefined for a substitute. */
  readonly source?: string;
  readonly substitute: boolean;
  readonly rationale: string;
}

export interface Theme {
  readonly id: string;
  readonly year: number;
  readonly name: string;
  readonly source: readonly SourceColour[];
  readonly roles: Readonly<Record<Role, RoleChoice>>;
  readonly scales: Readonly<Record<Role, Readonly<Record<Step, string>>>>;
  /** The steps dark mode re-points, where the light values miss a contrast target. */
  readonly dark?: Partial<Readonly<Record<Role, Partial<Readonly<Record<Step, string>>>>>>;
}

interface Catalogue {
  readonly default: {
    readonly id: string;
    readonly name: string;
    readonly aliases: Readonly<Record<Role, string>>;
  };
  readonly themes: readonly Theme[];
}

const CATALOGUE: Catalogue = catalogue;

export const THEMES = CATALOGUE.themes;
export const DEFAULT_THEME = CATALOGUE.default;
const BY_ID: ReadonlyMap<string, Theme> = new Map(THEMES.map((theme) => [theme.id, theme]));

/** 'default', or the id of a theme in themes.json. */
export type ThemeId = string;

export interface ThemeConfig {
  /** The theme a visitor sees unless they chose another. */
  readonly theme: ThemeId;
  /** Whether visitors may pick a theme (USER_THEMES), which their browser then keeps. */
  readonly userThemes: boolean;
  /** Where the site keeps a visitor's light/dark choice: the `dark` class on <html> then follows
   *  it, or the system, from before first paint. */
  readonly modeKey?: string;
}

/** The attribute on <html> naming the theme; Starlight's data-theme already carries light/dark. */
export const PALETTE_ATTRIBUTE = 'data-palette';
export const STORAGE_KEY = 'sites-theme';

/** The themes visitors may pick, in the pickers' order, by the names they show; the id stays the
 *  catalogue's. A site's configuration may still name any theme. */
const USER_THEME_LABELS: ReadonlyMap<ThemeId, string> = new Map([
  ['classic-blue', 'Andromeda'],
  ['serenity-and-rose-quartz', 'Hercules'],
  ['blue-turquoise', 'Perseus'],
  ['emerald', 'Sextans'],
  ['ultimate-gray-and-illuminating', 'Tucana'],
]);

export const USER_THEMES: readonly ThemeId[] = [...USER_THEME_LABELS.keys()];

export const isThemeId = (id: ThemeId): boolean => id === 'default' || BY_ID.has(id);

/** The themes a site offers: the default, the site's own and USER_THEMES, or its own alone. */
export const selectable = ({ theme, userThemes }: ThemeConfig): readonly ThemeId[] =>
  userThemes ? [...new Set(['default', theme, ...USER_THEMES])] : [theme];

const labelOf = (id: ThemeId): string => {
  const own = USER_THEME_LABELS.get(id);
  if (own !== undefined) {
    return own;
  }
  const theme = BY_ID.get(id);
  return theme === undefined ? DEFAULT_THEME.name : theme.name;
};

/** Every choice a site's picker offers, the default first, each with its name. */
export const choices = (config: ThemeConfig): readonly { id: ThemeId; label: string }[] =>
  selectable(config).map((id) => ({ id, label: labelOf(id) }));
