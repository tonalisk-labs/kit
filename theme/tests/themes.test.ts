import assert from 'node:assert/strict';
import { test } from 'node:test';

import { choices, isThemeId, THEMES, USER_THEMES } from '../themes/index.ts';

await test('every catalogued theme and the default are known ids; anything else is not', () => {
  assert.ok(isThemeId('default'));
  assert.ok(THEMES.every(({ id }) => isThemeId(id)));
  assert.ok(USER_THEMES.every((id) => isThemeId(id)));
  assert.equal(isThemeId('no-such-theme'), false);
  assert.equal(isThemeId('toString'), false);
});

await test('choices label the themes visitors may pick by their own names, the rest by the catalogue', () => {
  const offered = choices({ theme: 'default', userThemes: true });
  assert.deepEqual(offered, [
    { id: 'default', label: 'Default' },
    { id: 'classic-blue', label: 'Andromeda' },
    { id: 'serenity-and-rose-quartz', label: 'Hercules' },
    { id: 'blue-turquoise', label: 'Perseus' },
    { id: 'emerald', label: 'Sextans' },
    { id: 'ultimate-gray-and-illuminating', label: 'Tucana' },
  ]);
  assert.deepEqual(
    offered.slice(1).map(({ id }) => id),
    USER_THEMES,
  );
  const named = new Map(offered.map(({ id, label }) => [id, label]));
  for (const theme of THEMES) {
    const label = named.get(theme.id) ?? theme.name;
    assert.deepEqual(choices({ theme: theme.id, userThemes: false }), [{ id: theme.id, label }]);
  }
});
