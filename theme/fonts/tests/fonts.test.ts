import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AstroConfig, AstroIntegration } from 'astro';

import {
  BODY_FONT,
  type FontChoice,
  installedStack,
  isFontChoice,
  MODULE,
  siteFont,
} from '../index.ts';

interface Plugin {
  resolveId: (id: string) => string | undefined;
  load: (id: string) => string | undefined;
}

const isPlugin = (value: unknown): value is Plugin =>
  typeof value === 'object' && value !== null && 'resolveId' in value && 'load' in value;

const pluginOf = async (choice: FontChoice): Promise<Plugin> => {
  const updates: Partial<AstroConfig>[] = [];
  const integration: AstroIntegration = siteFont(choice);
  const updateConfig = (update: Partial<AstroConfig>): number => updates.push(update);
  await Reflect.apply(integration.hooks['astro:config:setup'] ?? Object, undefined, [
    { updateConfig },
  ]);
  assert.equal(updates.length, 1);
  const [{ vite: { plugins = [] } = {} } = {}] = updates;
  const [plugin, ...others]: readonly unknown[] = plugins;
  assert.deepEqual(others, []);
  if (!isPlugin(plugin)) {
    throw new Error('siteFont adds no Vite plugin');
  }
  return plugin;
};

const served = (plugin: Plugin, id: string): string | undefined => {
  const resolved = plugin.resolveId(id);
  return resolved === undefined ? undefined : plugin.load(resolved);
};

const stylesheetOf = (plugin: Plugin): string => {
  const [, id = ''] = /^import '(?<id>[^']+)';$/u.exec(served(plugin, MODULE) ?? '') ?? [];
  return served(plugin, id) ?? '';
};

await test('the system font brings no stylesheet', async () => {
  const plugin = await pluginOf('system');
  assert.equal(served(plugin, MODULE), '');
  assert.equal(served(plugin, 'virtual:@tonalisk-labs/kit/fonts/body.css'), undefined);
});

await test('Palatino asks for each system name, then the music signs, then the system font', () => {
  assert.equal(
    installedStack('palatino'),
    "'Palatino Linotype', 'Palatino', 'Music signs', var(--font-sans)",
  );
});

await test('an installed family sets its stack in --font-body, and downloads nothing', async () => {
  const css = stylesheetOf(await pluginOf('palatino'));
  assert.ok(css.endsWith(`:root { ${BODY_FONT}: ${installedStack('palatino')}; }\n`), css);
  assert.doesNotMatch(css, /url\(/u);
});

await test('the music signs come from installed fonts, and only for the signs', async () => {
  const css = stylesheetOf(await pluginOf('palatino'));
  const [face = ''] = /@font-face \{[^}]*\}/u.exec(css) ?? [];
  assert.match(face, /font-family: 'Music signs';/u);
  assert.match(face, /src: local\('STIX Two Math Regular'\), local\('STIXTwoMath-Regular'\), /u);
  assert.match(face, /local\('Segoe UI Symbol'\), local\('SegoeUISymbol'\);/u);
  assert.match(face, /unicode-range: U\+2669-266F;/u);
});

await test('the plugin serves its own modules alone', async () => {
  const plugin = await pluginOf('palatino');
  assert.equal(plugin.resolveId('virtual:@tonalisk-labs/kit/themes'), undefined);
  assert.equal(plugin.load('\0virtual:@tonalisk-labs/kit/themes'), undefined);
});

await test('the system font and each installed family are choices; anything else is not', () => {
  assert.ok(isFontChoice('system'));
  assert.ok(isFontChoice('palatino'));
  assert.equal(isFontChoice('tex-gyre-pagella'), false);
  assert.equal(isFontChoice('toString'), false);
});
