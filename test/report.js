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
  let totalPassed = 0, grandTotal = 0;
  const [results, baseResults] = await Promise.all([
    loadResults(), 
    findBaseResults({ github, context })
  ]);
  const rows = [
    `## Test results`,
    ``,
  ];

  if (!baseResults) {
    rows.unshift(
      `> :exclamation: No results found for base commit. Results delta is unknown.`,
      ``,
    );
  }

  // Build a markdown table

  Object.keys(results).forEach((suiteName, row) => {
    const colKeys = Object.keys(results[suiteName]).sort();

    if (!row) {
      // Write header
      rows.push(
        `| Test suite | ${colKeys.join(' | ')} |`,
        `|------------| ${colKeys.map(() => '---').join('|')}|`,
      );
    }

    // Write the row

    const cols = colKeys
      .map(flattening => {
        const { pass = 0, fail = 0, skipped = 0 } = results[suiteName][flattening];
        const total = pass + fail + skipped;
        // const percent = (pass / total) * 100;

        totalPassed += pass;
        grandTotal += total;
        let row = `\`${pass} / ${total}\``;

        const base = ((baseResults || {})[suiteName] || {})[flattening];
        if (base) {
          // const basePercent = (base.pass / (base.pass + base.skipped + base.fail)) * 100;
          const diff = pass - base.pass;
          const sign = (diff > 0) ? '+' : '';
          row += ` (Δ \`${sign}${diff})\``;
        } else {
          row += ` (Δ ?)`;
        }

        return row;
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
    const flattening = /(flatten_\w+)\/results.json$/.exec(file)[1];
    
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

  const opts = github.repos.listCommentsForCommit.endpoint.merge({
    ...context.repo,
    commit_sha: context.payload.pull_request
      ? context.payload.pull_request.base.sha
      : context.payload.before,
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
    ? github.issues.listComments.endpoint.merge({
        ...context.repo,
        issue_number: context.issue.number,
    })
    : github.repos.listCommentsForCommit.endpoint.merge({
      ...context.repo,
      commit_sha: context.sha,
    });

  const comment = await paginateFilteringFingerprint(opts, { github });

  const fingerprintedBody = `<!-- ${fingerprint}\n${JSON.stringify(meta)}\n-->\n${body}`;
  if (comment) {
    const endpoint = context.payload.pull_request
      ? github.issues.updateComment
      : github.repos.updateCommitComment;

    await endpoint({
      ...context.repo,
      comment_id: comment.id,
      body: fingerprintedBody,
    });
  } else {
    if (context.payload.pull_request) {
      await github.issues.createComment({
        ...context.repo,
        issue_number: context.issue.number,
        body: fingerprintedBody,
      });
    } else {
      await github.repos.createCommitComment({
        ...context.repo,
        commit_sha: context.sha,
        body: fingerprintedBody,
      });
    }
  }
};



/**
 * 
 * @param {any} opts
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
