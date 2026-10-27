import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Playwright specs run through `playwright test`; vitest cannot load them.
    exclude: [...configDefaults.exclude, 'test/e2e/**'],
  },
});
