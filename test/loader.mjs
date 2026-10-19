import { realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const profileModules = path.join(os.homedir(), ".dsh", "profiles", "node_modules");
const targets = new Map([
  ["@deepseek-ai/dsh-web", path.join(profileModules, "@deepseek-ai", "dsh-web", "lib", "index.js")],
  ["@deepseek-ai/cordis", path.join(profileModules, "@deepseek-ai", "cordis", "lib", "index.js")],
  ["@deepseek-ai/dsh-launch-environment", path.join(profileModules, "@deepseek-ai", "dsh-launch-environment", "lib", "index.js")],
  ["@deepseek-ai/schemastery", path.join(profileModules, "@deepseek-ai", "schemastery", "lib", "index.mjs")],
]);

export async function resolve(specifier, context, nextResolve) {
  const target = targets.get(specifier);
  if (target !== undefined) {
    return { url: pathToFileURL(realpathSync(target)).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
