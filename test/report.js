/**
 * This is a GitHub Script which reports the pass/fail results
 * of each test run onto the PR.
 * 
 * See: https://github.com/marketplace/actions/github-script
 */

module.exports = async ({ github, context, core, io }) => {
  const results = await loadResults();
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
  github.issues.createComment({
    issue_number: context.issue.number,
    owner: context.repo.owner,
    repo: context.repo.repo,
    body: rows.join('\n'),
  });

  return `Total passed ${totalPassed} out of ${grandTotal}`;
};



/**
 * @returns {{ [suite: string]: { [flattening: string]: { pass: number, fail: number, skipped: number } } }}
 */
const loadResults = () => {
  // TODO
};
