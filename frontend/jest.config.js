/* eslint-disable @typescript-eslint/no-require-imports */
const nextJest = require("next/jest");

const createJestConfig = nextJest({
  dir: "./",
});

const customJestConfig = {
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  testEnvironment: "jest-environment-jsdom",
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  testPathIgnorePatterns: ["<rootDir>/e2e/", "<rootDir>/node_modules/"],
};

// next/jest appends custom transformIgnorePatterns after its own defaults,
// so overriding inline does not work. Instead, we wrap the async config
// function and replace transformIgnorePatterns after next/jest builds it.
const jestConfig = createJestConfig(customJestConfig);

module.exports = async () => {
  const config = await jestConfig();
  // Allow @stellar/stellar-sdk and @noble/* (ESM-only packages) to be
  // transformed by the SWC/Babel transformer rather than ignored.
  config.transformIgnorePatterns = [
    "/node_modules/(?!(@stellar/stellar-sdk|@noble|@bufbuild|eventsource-parser|uint8array-extras)/)",
    "^.+\\.module\\.(css|sass|scss)$",
  ];
  return config;
};
