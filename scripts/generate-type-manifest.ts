/**
 * generate-type-manifest.ts
 *
 * Reads the tRPC router index and all imported router files to produce
 * a JSON manifest of every procedure (name, type, auth level).
 * Output is written to stdout for piping into a file.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROUTER_INDEX = path.resolve(
  __dirname,
  "../backend/src/routers/index.ts"
);

interface Procedure {
  router: string;
  name: string;
  type: "query" | "mutation";
  authLevel: string;
}

function getGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function extractRouterMappings(
  indexSource: string
): Array<{ routerKey: string; importPath: string }> {
  // Match lines like:  task: taskRouter,
  const mappingRegex = /^\s*(\w+):\s*\w+Router,?/gm;
  const importRegex = /import\s*\{\s*\w+\s*\}\s*from\s*['"]\.\/([\w\-/]+)['"]/gm;

  // Build a map of router variable name -> relative import path
  const importMap = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(indexSource)) !== null) {
    // e.g. import { taskRouter } from './task'  =>  taskRouter -> task
    const varMatch = /import\s*\{\s*(\w+)\s*\}/.exec(m[0]);
    if (varMatch) {
      importMap.set(varMatch[1], m[1]);
    }
  }

  // Build router key -> import path mapping from the appRouter definition
  const routerDefMatch = indexSource.match(
    /export const appRouter\s*=\s*router\(\{([\s\S]*?)\}\);/
  );
  if (!routerDefMatch) return [];

  const routerBody = routerDefMatch[1];
  const results: Array<{ routerKey: string; importPath: string }> = [];
  const entryRegex = /(\w+):\s*(\w+)/g;
  while ((m = entryRegex.exec(routerBody)) !== null) {
    const key = m[1];
    const varName = m[2];
    const importPath = importMap.get(varName);
    if (importPath) {
      results.push({ routerKey: key, importPath });
    }
  }
  return results;
}

function extractProcedures(
  routerKey: string,
  source: string
): Procedure[] {
  const procedures: Procedure[] = [];

  // Match procedure definitions like:
  //   create: protectedProcedure  ...  .mutation(
  //   listOpen: publicProcedure   ...  .query(
  const procRegex =
    /(\w+):\s*(protectedProcedure|publicProcedure|adminProcedure)/g;
  let match: RegExpExecArray | null;

  while ((match = procRegex.exec(source)) !== null) {
    const name = match[1];
    const authLevel = match[2].replace("Procedure", "");
    const afterDef = source.slice(match.index);

    // Find the first .query( or .mutation( after this definition
    const typeMatch = afterDef.match(/\.(query|mutation)\(/);
    const procType: "query" | "mutation" = typeMatch
      ? (typeMatch[1] as "query" | "mutation")
      : "query";

    procedures.push({
      router: routerKey,
      name,
      type: procType,
      authLevel,
    });
  }

  return procedures;
}

function main(): void {
  const indexSource = fs.readFileSync(ROUTER_INDEX, "utf-8");
  const mappings = extractRouterMappings(indexSource);
  const routersDir = path.dirname(ROUTER_INDEX);

  const allProcedures: Procedure[] = [];

  for (const { routerKey, importPath } of mappings) {
    const filePath = path.resolve(routersDir, importPath + ".ts");
    if (!fs.existsSync(filePath)) continue;

    const source = fs.readFileSync(filePath, "utf-8");
    const procs = extractProcedures(routerKey, source);
    allProcedures.push(...procs);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    backendSha: getGitSha(),
    procedures: allProcedures,
  };

  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
}

main();
