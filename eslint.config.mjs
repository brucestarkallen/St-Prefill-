export default [
    {
        files: ['engine.js', 'index.js', '*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                console: 'readonly',
                document: 'readonly',
                globalThis: 'readonly',
                process: 'readonly',
                structuredClone: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': 'error',
            'no-undef': 'error',
            'eqeqeq': ['error', 'always'],
            'no-var': 'error',
            'prefer-const': 'error',
            'semi': ['error', 'always'],
        },
    },
];
