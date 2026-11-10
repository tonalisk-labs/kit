import { test as base } from '@playwright/test';

import { control } from './stack/control.ts';

const teardown = base.extend<object, { readonly site: string }>({
  site: ['', { option: true, scope: 'worker' }],
});

teardown('the services this target started are stopped', async ({ site }) => {
  await control('stop', site);
});
