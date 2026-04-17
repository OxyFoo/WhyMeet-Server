/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
    },
    transformIgnorePatterns: [
        'node_modules/(?!@oxyfoo/whymeet-types)',
    ],
    transform: {
        '^.+\.tsx?$': ['ts-jest', { tsconfig: { module: 'CommonJS' } }],
        '^.+\\.jsx?$': ['ts-jest', { useESM: false }],
    },
};
