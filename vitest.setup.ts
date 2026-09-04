// Registers jest-dom's DOM matchers (toBeInTheDocument, etc.) globally.
// Safe under the default "node" environment too — it only calls
// expect.extend, it doesn't touch `document` at import time — so this
// doesn't affect the non-component tests that make up most of the suite.
import "@testing-library/jest-dom/vitest";
