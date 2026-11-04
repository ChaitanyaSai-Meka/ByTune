/**
 * Loads a module of src/ (TypeScript) for the harnesses that run electron/main.ts with a require of
 * their own: `srcModule("../src/lib/roomSync")`, as main.ts names it. Built once per file.
 */
import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const built = new Map();

export function srcModule(spec) {
  const file = fileURLToPath(new URL(`../../${spec.replace(/^\.\.\//, "")}.ts`, import.meta.url));
  if (!built.has(file)) {
    const { outputFiles } = buildSync({ entryPoints: [file], bundle: true, format: "cjs", platform: "node", write: false });
    const module = { exports: {} };
    new Function("module", "exports", "require", outputFiles[0].text)(module, module.exports, require);
    built.set(file, module.exports);
  }
  return built.get(file);
}
