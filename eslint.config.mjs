import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-plugin-prettier';

export default [
    { ignores: ['**/dist/**', '**/node_modules/**'] },

    pluginJs.configs.recommended,
    ...tseslint.configs.recommended,

    {
        files: ['**/*.{js,mjs,cjs,ts}'],
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        plugins: {
            prettier: prettier
        },
        rules: {
            semi: ['warn', 'always'],
            quotes: [
                'warn',
                'single',
                {
                    avoidEscape: true,
                    allowTemplateLiterals: true
                }
            ],
            'no-control-regex': 'off',
            'comma-dangle': ['warn', 'never'],
            'eol-last': ['warn', 'always'],
            'max-len': [
                'error',
                {
                    code: 120,
                    ignoreUrls: true,
                    ignoreComments: true,
                    ignoreStrings: true,
                    ignoreTemplateLiterals: true
                }
            ],
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_'
                }
            ],
            'prettier/prettier': [
                'warn',
                {
                    singleQuote: true,
                    tabWidth: 4,
                    trailingComma: 'none',
                    printWidth: 120
                }
            ]
        }
    }
];
