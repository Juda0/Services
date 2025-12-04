import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  {
    files: ['**/*.{js,mjs,cjs}'],
    plugins: { js },
    extends: ['js/recommended'],
    languageOptions: {
      sourceType: 'module', // use ES modules so import/export are allowed
      globals: { ...globals.node }, // explicitly set Node globals
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^err$' }], // optional
    },
  },
]);
