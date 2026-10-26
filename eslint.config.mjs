import tseslint from 'typescript-eslint';

export default tseslint.config(
  // .wrangler: wrangler dev's bundles (tens of MB of generated JS)
  { ignores: ['**/dist/**', '**/node_modules/**', '**/reports/**', '**/.wrangler/**', 'docs/**'] },
  ...tseslint.configs.recommended,
);
