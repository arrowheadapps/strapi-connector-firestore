const fs = require('fs-extra');
const path = require('path');
const glob = require('glob-promise');

/**
 * This is a GitHub Script which reports the pass/fail results
 * of each test run onto the PR.
 * 
 * See: https://github.com/marketplace/actions/github-script
 */
module.exports = async ({ github, context, core, io }) => {
  const [results, baseResults] = await Promise.all([
    loadResults(), 
    findBaseResults()
  ]);
  const rows = [
    `## Test results`,
    ``
  ];
  const totalPassed = 0;
  const grandTotal = 0;

  // Build a markdown table

  Object.keys(results).forEach((suiteName, row) => {
    if (!row) {
      // Write header
      rows.push(
        `| Test suite | ${Object.keys(results[suiteName]).join(' | ')} |`,
        `|------------| ${Object.keys(results[suiteName]).map(() => '---').join('|')}|`,
      );
    }

    // Write the row

    const cols = Object.keys(results[suiteName])
      .map(flattening => {
        const { pass = 0, fail = 0, skipped = 0 } = results[suiteName][flattening];
        const total = pass + fail + skipped;

        totalPassed += pass;
        grandTotal += total;

        return `${pass} / ${total} (${(pass + total).toFixed(1)}%)`;
      })
      .join(' | ');

    rows.push(
      `| ${suiteName} | ${cols} |`,
    );
  });

  // Post the comment
  await updateComment(rows.join('\n'), { github, context });

  return `Total passed ${totalPassed} out of ${grandTotal}`;
};



/**
 * @returns {{ [suite: string]: { [flattening: string]: { pass: number, fail: number, skipped: number } } }}
 */
const loadResults = async () => {
  const results = {};
  const resultFiles = await glob.promise('coverage/*/results.json');
  await Promise.all(resultFiles.map(file => {
    const obj = await fs.readJSON(file);
    const flattening = path.basename(file).split('.')[0];
    results['Total'] = results['Total'] || {};
    results['Total'][flattening] = results['Total'][flattening] || {};
    results['Total'][flattening].pass = obj.numPassedTests;
    results['Total'][flattening].fail = obj.numFailedTests;
    results['Total'][flattening].skipped = obj.numPendingTests;
  }));

  return results;
};

/**
 * @returns {{ [suite: string]: { [flattening: string]: { pass: number, fail: number, skipped: number } } }}
 */
const findBaseResults = async ({ github, context }) => {
  // TODO
  return {};
};

const updateComment = async (body, { github, context }) => {

  // TODO:
  // Find existing comment if it exists
  // and updated it or create a new comment

  await github.issues.createComment({
    issue_number: context.issue.number,
    owner: context.repo.owner,
    repo: context.repo.repo,
    body,
  });

};


