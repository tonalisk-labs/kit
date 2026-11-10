import { test as base } from '@playwright/test';

import { control } from './stack/control.ts';

const setup = base.extend<object, { readonly site: string }>({
  site: ['', { option: true, scope: 'worker' }],
});

setup('the services this target declares are started', async ({ site }) => {
  Object.assign(process.env, await control('start', site));
});
