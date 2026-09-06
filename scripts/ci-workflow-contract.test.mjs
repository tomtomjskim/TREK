import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(rootDir, '.github/workflows/test.yml');
const sonarPropertiesPath = path.join(rootDir, 'sonar-project.properties');
const readmePath = path.join(rootDir, 'README.md');

async function readText(relativePath) {
  return readFile(relativePath, 'utf8');
}

function findLineIndex(lines, pattern, fromIndex = 0) {
  for (let index = fromIndex; index < lines.length; index++) {
    if (pattern.test(lines[index])) {
      return index;
    }
  }

  return -1;
}

function extractSameIndentBlock(lines, startPattern, stopPattern) {
  const startIndex = findLineIndex(lines, startPattern);
  assert.ok(startIndex >= 0, `missing block start: ${startPattern}`);

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index++) {
    if (stopPattern.test(lines[index])) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex, endIndex);
}

function extractIndentedBlock(lines, startPattern) {
  const startIndex = findLineIndex(lines, startPattern);
  assert.ok(startIndex >= 0, `missing block start: ${startPattern}`);

  const startIndent = lines[startIndex].match(/^ */)?.[0].length ?? 0;
  let endIndex = lines.length;

  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent <= startIndent) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex, endIndex);
}

function withoutCommentOnlyLines(lines) {
  return lines.filter((line) => {
    const trimmed = line.trimStart();
    return trimmed.length > 0 && !trimmed.startsWith('#');
  });
}

test('optional sonar scan job is scoped to the scan block', async () => {
  const workflow = await readText(workflowPath);

  const workflowLines = workflow.split(/\r?\n/);
  const scanBlock = extractSameIndentBlock(
    workflowLines,
    /^\s{2}scan:\s*$/,
    /^\s{2}[A-Za-z0-9_-]+:\s*$/,
  );
  const scanExecutionText = withoutCommentOnlyLines(scanBlock).join('\n');
  const normalizedScanExecutionText = scanExecutionText.replace(/\s+/g, ' ');

  assert.match(
    normalizedScanExecutionText,
    /\bname:\s*Optional Sonar Scan\b/,
    'scan display name must be Optional Sonar Scan',
  );

  assert.match(
    normalizedScanExecutionText,
    /vars\.SONAR_ENABLED\s*==\s*['"]true['"]/,
    'scan job must require vars.SONAR_ENABLED == "true"',
  );
  assert.match(
    normalizedScanExecutionText,
    /github\.event_name\s*!=\s*['"]pull_request['"]\s*\|\|\s*github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/,
    'scan job must protect same-repository pull requests',
  );

  const preflightIndex = findLineIndex(scanBlock, /^\s{6}- name:\s*Sonar preflight\s*$/);
  const scanActionIndex = findLineIndex(
    scanBlock,
    /^\s{8}uses:\s*SonarSource\/sonarqube-scan-action@/,
  );
  assert.ok(scanActionIndex >= 0, 'scan job must invoke the Sonar scan action');
  assert.ok(
    preflightIndex >= 0 && preflightIndex < scanActionIndex,
    'Sonar preflight must run before the scan action',
  );

  const preflightBlock = extractSameIndentBlock(
    scanBlock,
    /^\s{6}- name:\s*Sonar preflight\s*$/,
    /^\s{6}- /,
  );
  const preflightText = preflightBlock.join('\n');

  assert.match(
    preflightText,
    /SONAR_TOKEN:\s*\$\{\{\s*secrets\.SONAR_TOKEN\s*\}\}/,
    'preflight must wire SONAR_TOKEN from secrets',
  );
  assert.match(
    preflightText,
    /SONAR_PROJECT_KEY:\s*\$\{\{\s*vars\.SONAR_PROJECT_KEY\s*\}\}/,
    'preflight must wire SONAR_PROJECT_KEY from vars',
  );
  assert.match(
    preflightText,
    /SONAR_ORGANIZATION:\s*\$\{\{\s*vars\.SONAR_ORGANIZATION\s*\}\}/,
    'preflight must wire SONAR_ORGANIZATION from vars',
  );
  assert.match(
    preflightText,
    /for name in SONAR_TOKEN SONAR_PROJECT_KEY SONAR_ORGANIZATION; do/,
    'preflight must check all three variables',
  );
  assert.match(
    preflightText,
    /\[ -z "\$\{!name\}" \]/,
    'preflight must fail on empty values',
  );
  assert.doesNotMatch(
    preflightText,
    /(?:echo|printf)[^\n]*(?:\$\{!name\}|\$(?:\{)?SONAR_(?:TOKEN|PROJECT_KEY|ORGANIZATION)(?:\})?)/,
    'preflight must not print secret values',
  );

  assert.doesNotMatch(
    preflightText,
    /\bprintenv\b/,
    'preflight must not dump the environment',
  );
  assert.doesNotMatch(
    preflightText,
    /\bset -x\b/,
    'preflight must not enable shell tracing',
  );

  const scanActionBlock = extractSameIndentBlock(
    scanBlock,
    /^\s{6}- name:\s*Scan\s*$/,
    /^\s{6}- /,
  );
  const argsBlock = extractIndentedBlock(scanActionBlock, /^\s{10}args:\s*>\-\s*$/);
  const argsText = argsBlock.join('\n');

  assert.match(
    argsText,
    /-Dsonar\.projectKey=\$\{\{\s*vars\.SONAR_PROJECT_KEY\s*\}\}/,
    'scan args must use vars.SONAR_PROJECT_KEY',
  );
  assert.match(
    argsText,
    /-Dsonar\.organization=\$\{\{\s*vars\.SONAR_ORGANIZATION\s*\}\}/,
    'scan args must use vars.SONAR_ORGANIZATION',
  );
});

test('workflow name does not present Sonar as a core success condition', async () => {
  const workflow = await readText(workflowPath);

  assert.doesNotMatch(
    workflow.split(/\r?\n/)[0],
    /Sonar/i,
    'workflow name must not present Sonar as a core success condition',
  );
});

test('checked-in Sonar identity stays fork-owned', async () => {
  const [sonarProperties, readme] = await Promise.all([
    readText(sonarPropertiesPath),
    readText(readmePath),
  ]);

  assert.ok(
    !sonarProperties.includes('sonar.projectKey=liketrek_TREK'),
    'sonar-project.properties must not hard-code liketrek_TREK',
  );
  assert.ok(
    !sonarProperties.includes('sonar.organization=liketrek'),
    'sonar-project.properties must not hard-code sonar.organization=liketrek',
  );
  assert.doesNotMatch(
    readme,
    /https:\/\/sonarcloud\.io\/project\/overview\?id=liketrek_TREK/,
    'README must not keep the upstream Sonar project link',
  );
  assert.doesNotMatch(
    readme,
    /img\.shields\.io\/sonar\/quality_gate\/liketrek_TREK/,
    'README must not keep the upstream Sonar badge',
  );
});
