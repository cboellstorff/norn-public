// The K3 ruleset (ESLint flat config): unused variables and imports only. The `_x` habit (and caught errors, rest siblings) is allowed.
export default [{
  files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  rules: { 'no-unused-vars': ['error', { vars: 'all', args: 'after-used', caughtErrors: 'none', ignoreRestSiblings: true,
    varsIgnorePattern: '^_', argsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }] },
}];
