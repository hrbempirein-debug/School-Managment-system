// SMS-P40A — minimal ESLint flat configuration (Task 40).
//
// Scope is deliberately narrow: only packages/idempotency/src. Tests, generated
// output, migrations, documentation, and every other package/workspace are out
// of scope. Typed linting and broad recommended presets are intentionally NOT
// enabled, because they would surface unrelated pre-existing findings and turn
// this baseline into an unscoped cleanup.
import tseslint from 'typescript-eslint';

export default tseslint.config({
  name: 'sms/p40a-idempotency-minimal',
  files: ['packages/idempotency/src/**/*.ts'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  plugins: {
    '@typescript-eslint': tseslint.plugin,
  },
  rules: {
    // Minimal, explicit correctness rules (no preset bundles).
    'no-debugger': 'error',
    'no-dupe-keys': 'error',
    'no-unreachable': 'error',
    '@typescript-eslint/no-unused-vars': ['error'],

    // Raw-SQL restriction. The repository's documented spelling `.$raw` does not
    // exist in source; the actual Drizzle API is `sql.raw(...)`
    // (see packages/idempotency/src/index.ts). The three savepoint-control calls
    // there carry narrowly scoped inline exceptions with a stated reason.
    'no-restricted-syntax': [
      'error',
      {
        selector: "CallExpression[callee.object.name='sql'][callee.property.name='raw']",
        message:
          'Raw SQL via sql.raw(...) is restricted outside packages/db. Prefer parameterized Drizzle builders; if genuinely required, add a narrowly scoped eslint-disable-next-line with a reason.',
      },
    ],
  },
});
