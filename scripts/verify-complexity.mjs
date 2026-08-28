import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';

const MAX_FILE_LOC = 400;
const MAX_CYCLOMATIC = 10;
const MAX_PARAMS = 5;

function changedProductionFiles() {
  const tracked = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD', '--', 'backend/src'],
    { encoding: 'utf8' },
  );
  const untracked = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '--', 'backend/src'],
    { encoding: 'utf8' },
  );
  return [...new Set((tracked + '\n' + untracked).split('\n'))]
    .filter((file) => file.endsWith('.ts') && existsSync(file))
    .filter((file) => !/(?:^|\/)(?:test|tests|fixtures|generated)(?:\/|$)/.test(file))
    .filter((file) => !/\.(?:test|spec)\.ts$/.test(file));
}

const files = changedProductionFiles();
if (files.length === 0) {
  console.log(JSON.stringify({ ok: true, checked_files: 0 }));
  process.exit(0);
}

const oversized = files
  .map((file) => ({ file, loc: readFileSync(file, 'utf8').split(/\r?\n/).length }))
  .filter(({ loc }) => loc > MAX_FILE_LOC);

function isFunction(node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node);
}

function functionName(node, sourceFile) {
  if ('name' in node && node.name) return node.name.getText(sourceFile);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.name) return parent.name.getText(sourceFile);
  if (ts.isPropertyAssignment(parent)) return parent.name.getText(sourceFile);
  return '<anonymous>';
}

function branchWeight(node) {
  if (
    ts.isIfStatement(node)
    || ts.isForStatement(node)
    || ts.isForInStatement(node)
    || ts.isForOfStatement(node)
    || ts.isWhileStatement(node)
    || ts.isDoStatement(node)
    || ts.isConditionalExpression(node)
    || ts.isCatchClause(node)
    || ts.isCaseClause(node)
  ) return 1;
  if (
    ts.isBinaryExpression(node)
    && [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(node.operatorToken.kind)
  ) return 1;
  return 0;
}

function complexityOf(target) {
  let complexity = 1;
  function visit(node) {
    if (node !== target && isFunction(node)) return;
    complexity += branchWeight(node);
    ts.forEachChild(node, visit);
  }
  if (target.body) visit(target.body);
  return complexity;
}

const functionViolations = [];
for (const file of files) {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  function visit(node) {
    if (isFunction(node)) {
      const complexity = complexityOf(node);
      const parameterCount = node.parameters.length;
      if (complexity > MAX_CYCLOMATIC || parameterCount > MAX_PARAMS) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        functionViolations.push({
          file,
          line: line + 1,
          function: functionName(node, sourceFile),
          complexity,
          parameters: parameterCount,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

const report = {
  ok: oversized.length === 0 && functionViolations.length === 0,
  checked_files: files.length,
  limits: {
    max_file_loc: MAX_FILE_LOC,
    max_cyclomatic: MAX_CYCLOMATIC,
    max_params: MAX_PARAMS,
  },
  oversized,
  function_violations: functionViolations,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
