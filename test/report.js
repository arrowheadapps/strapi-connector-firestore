const fs = require('fs-extra');
const path = require('path');
const glob = require('glob-promise');

const fingerprint = 'strapi-connector-firestore-bot-results';


/**
 * Pull in type definitions for the available context variables.
 * 
 * @typedef {InstanceType<import('@actions/github/lib/utils').GitHub>} GitHub
 * @typedef {import('@actions/github').context} Context
 * @typedef {import('@actions/core')} Core
 * @typedef {import('@actions/io')} Io
 * 
 * @typedef {{ 
 *  github: GitHub,
 *  context: Context,
 *  core: Core,
 *  io: Io
 * }} GitHubContext 
 */

 /**
  * Define result structure
  * @typedef {{ [suite: string]: { [flattening: string]: { pass: number, fail: number, skipped: number } } }} TestResult 
  */


/**
 * This is a GitHub Script which reports the pass/fail results
 * of each test run onto the PR.
 * 
 * See: https://github.com/marketplace/actions/github-script
 * 
 * @param {GitHubContext}
 */
module.exports = async ({ github, context, core, io }) => {
  const [results, baseResults] = await Promise.all([
    loadResults(), 
    findBaseResults()
  ]);
  const rows = [
    `## Test results`,
    ``,
  ];
  const totalPassed = 0;
  const grandTotal = 0;

  if (!baseResults) {
    rows.unshift(
      `| :exclamation: No results found for base commit.`,
      ``,
    );
  }

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
        const row = `${pass} / ${total} (${(pass + total).toFixed(1)}%)`;

        if (baseResults) {
          const base = results[suiteName]?.[flattening];
          if (base) {
            row += ` (Δ ?)`;
          } else {
            row += ` (Δ ${(base.pass / (base.pass + base.skipped + base.fail)).toFixed(1)}%)`;
          }
        }
      })
      .join(' | ');

    rows.push(
      `| ${suiteName} | ${cols} |`,
    );
  });

  // Post the comment
  await updateComment(rows.join('\n'), results, { github, context });

  return `Total passed ${totalPassed} out of ${grandTotal}`;
};



/**
 * @returns {TestResult}
 */
const loadResults = async () => {
  const results = {};
  const resultFiles = await glob.promise('coverage/*/results.json');
  await Promise.all(resultFiles.map(async file => {
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
 * @param {GitHubContext}
 * @returns {TestResult}
 */
const findBaseResults = async ({ github, context }) => {
  
  const opts = context.payload.pull_request
    ? github.repos.listCommentsForCommit.endpoint.defaults({
        ...context.repo,
        commit_sha: context.payload.pull_request.base.sha,
    })
    : github.repos.listCommentsForCommit.endpoint.defaults({
      ...context.repo,
      commit_sha: context.payload.base.sha,
    });

  const comment = await paginateFilteringFingerprint(opts, { github });
  if (comment) {
    const regexp = new RegExp(`<!-- ${fingerprint}\n(.*)\n-->\n`);
    const match = regexp.exec(comment.body);
    if (match) {
      return JSON.parse(match[1]) || null;
    }
  }

  return null;
};

/**
 * 
 * @param {string} body 
 * @param {TestResult} meta 
 * @param {GitHubContext}
 */
const updateComment = async (body, meta, { github, context }) => {

  const opts = context.payload.pull_request
    ? github.issues.listComments.endpoint.defaults({
        ...context.repo,
        issue_number: context.issue.number,
    })
    : github.repos.listCommentsForCommit.endpoint.defaults({
      ...context.repo,
      commit_sha: null,
    });

  const comment = await paginateFilteringFingerprint(opts, { github });
  const fingerprintedBody = `<!-- ${fingerprint}\n${JSON.stringify(meta)}\n-->\n${body}`;
  
  if (comment) {
    await github.issues.updateComment({
      ...context.repo,
      comment_id: comment.id,
      body: fingerprintedBody,
    });
  } else {
    await github.issues.createComment({
      ...context.repo,
      issue_number: context.issue.number,
      body: fingerprintedBody,
    });
  }
};



/**
 * 
 * @param {GitHubContext}
 */
const paginateFilteringFingerprint = async (opts, { github }) => {

  // Paginate and filter for comments that contain
  // the fingerprint of this bot
  // There should be one or zero
  const [comment] = await github.paginate(opts, (resp, done) => {
    const filtered = resp.data.filter(cmt => (cmt.body || '').includes(fingerprint));
    if (filtered.length) {
      done();
    }
    return filtered;
  });

  return comment || null;
};
