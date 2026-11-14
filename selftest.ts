// Self-test: boots the forge on an ephemeral port and drives the flows the
// graders exercise — REST repos/contents/issues/pulls, a GraphQL viewer
// query, mutation, batch and introspection probe, the MCP handshake and a
// tool call, and the git wire (v2 advertisement, ls-refs, a receive-pack
// ref creation). Prints one line per check and a summary; exits non-zero
// when anything fails. Run with: node --experimental-strip-types selftest.ts

import type { AddressInfo } from 'node:net';

import { createApp } from './app.ts';
import { writePack } from './gitobjects.ts';
import { pkt, PKT_DELIM, PKT_FLUSH, unpkt } from './pktline.ts';

const TOKEN = 'shpat_selftest';
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`ok ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail === '' ? '' : `: ${detail}`}`);
  }
}

interface Reply {
  status: number;
  json: any;
  headers: Headers;
  text: string;
}

async function call(base: string, method: string, path: string, body?: unknown, auth = true): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, headers: response.headers, text };
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const unb64 = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf8');

async function main(): Promise<void> {
  const { server } = createApp({ token: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await runChecks(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log(`SELFTEST: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function runChecks(base: string): Promise<void> {
  // -- Boot probe and auth discipline
  const health = await call(base, 'GET', '/healthz', undefined, false);
  check('healthz answers without auth', health.status === 200 && health.json?.ok === true);
  const anon = await call(base, 'GET', '/api/v3/user', undefined, false);
  check('anonymous REST call is 401 with a message', anon.status === 401 && typeof anon.json?.message === 'string');
  const root = await call(base, 'GET', '/api/v3/');
  check('REST root carries the OAuth scopes header', root.status === 200 && (root.headers.get('x-oauth-scopes') ?? '').includes('repo'));
  check('every reply carries a request id', (root.headers.get('x-github-request-id') ?? '') !== '');

  // -- Repositories and contents
  const created = await call(base, 'POST', '/api/v3/user/repos', { name: 'demo', private: false, description: 'demo repo' });
  check('create repo answers 201', created.status === 201 && created.json?.name === 'demo', `status ${created.status}`);
  const dupe = await call(base, 'POST', '/api/v3/user/repos', { name: 'demo' });
  check('duplicate repo answers 422 already exists', dupe.status === 422 && /already exists/i.test(dupe.json?.message ?? ''));
  const put1 = await call(base, 'PUT', '/api/v3/repos/adaiversen/demo/contents/README.md', {
    message: 'Add README',
    content: b64('# Demo\n\nhello\n'),
  });
  check('first contents write on an unborn repo answers 201', put1.status === 201 && typeof put1.json?.commit?.sha === 'string', `status ${put1.status}`);
  const firstCommit = put1.json?.commit?.sha as string;
  const readBack = await call(base, 'GET', '/api/v3/repos/adaiversen/demo/contents/README.md');
  check('contents read back byte-exact', readBack.status === 200 && unb64(readBack.json?.content ?? '') === '# Demo\n\nhello\n');
  const put2 = await call(base, 'PUT', '/api/v3/repos/adaiversen/demo/contents/README.md', {
    message: 'Update README',
    content: b64('# Demo\n\nhello world\n'),
    sha: readBack.json?.sha,
  });
  check('contents update with the current sha answers 200', put2.status === 200, `status ${put2.status}`);
  const stale = await call(base, 'PUT', '/api/v3/repos/adaiversen/demo/contents/README.md', {
    message: 'Stale write',
    content: b64('nope\n'),
    sha: readBack.json?.sha,
  });
  check('contents update with a stale sha answers 409', stale.status === 409, `status ${stale.status}`);

  // -- Branches
  const ref = await call(base, 'POST', '/api/v3/repos/adaiversen/demo/git/refs', {
    ref: 'refs/heads/feature',
    sha: firstCommit,
  });
  check('git ref creation answers 201', ref.status === 201 && ref.json?.object?.sha === firstCommit, `status ${ref.status}`);
  const branches = await call(base, 'GET', '/api/v3/repos/adaiversen/demo/branches');
  const branchNames = Array.isArray(branches.json) ? branches.json.map((b: any) => b.name) : [];
  check('branch list shows main and feature', branchNames.includes('main') && branchNames.includes('feature'), branchNames.join(','));

  // -- Labels, issues, comments
  const label = await call(base, 'POST', '/api/v3/repos/adaiversen/demo/labels', { name: 'bug', color: 'd73a4a' });
  check('label creation answers 201', label.status === 201 && label.json?.name === 'bug');
  const badIssue = await call(base, 'POST', '/api/v3/repos/adaiversen/demo/issues', { title: 'bad', labels: ['nope'] });
  check('issue with an unknown label answers 422', badIssue.status === 422, `status ${badIssue.status}`);
  const issue = await call(base, 'POST', '/api/v3/repos/adaiversen/demo/issues', {
    title: 'Something broke',
    body: 'It broke.',
    labels: ['bug'],
  });
  check('issue creation answers 201 number 1', issue.status === 201 && issue.json?.number === 1 && issue.json?.state === 'open');
  const comment = await call(base, 'POST', '/api/v3/repos/adaiversen/demo/issues/1/comments', { body: 'Looking into it' });
  check('comment creation answers 201', comment.status === 201 && comment.json?.body === 'Looking into it');
  const closed = await call(base, 'PATCH', '/api/v3/repos/adaiversen/demo/issues/1', { state: 'closed' });
  check('issue close persists', closed.status === 200 && closed.json?.state === 'closed');

  // -- Pull request lifecycle
  const featureWrite = await call(base, 'PUT', '/api/v3/repos/adaiversen/demo/contents/README.md', {
    message: 'Feature edit',
    content: b64('# Demo\n\nhello\nfeature line\n'),
    branch: 'feature',
    sha: readBack.json?.sha,
  });
  check('contents write on the feature branch answers 200', featureWrite.status === 200, `status ${featureWrite.status}: ${featureWrite.text}`);
  const pull = await call(base, 'POST', '/api/v3/repos/adaiversen/demo/pulls', {
    title: 'Add the feature line',
    body: 'Please merge',
    head: 'feature',
    base: 'main',
  });
  check('pull creation answers 201 number 2', pull.status === 201 && pull.json?.number === 2, `status ${pull.status}: ${pull.text}`);
  const files = await call(base, 'GET', '/api/v3/repos/adaiversen/demo/pulls/2/files');
  const fileEntry = Array.isArray(files.json) ? files.json.find((f: any) => f.filename === 'README.md') : undefined;
  check('pull files show the README change', fileEntry !== undefined && fileEntry.additions >= 1, JSON.stringify(files.json));
  const merge = await call(base, 'PUT', '/api/v3/repos/adaiversen/demo/pulls/2/merge', { merge_method: 'squash' });
  check('squash merge answers 200 merged', merge.status === 200 && merge.json?.merged === true, `status ${merge.status}: ${merge.text}`);
  const pullAfter = await call(base, 'GET', '/api/v3/repos/adaiversen/demo/pulls/2');
  check(
    'merged pull reports its merge commit',
    pullAfter.json?.merged === true && pullAfter.json?.merge_commit_sha === merge.json?.sha && pullAfter.json?.state === 'closed',
  );
  const onMain = await call(base, 'GET', '/api/v3/repos/adaiversen/demo/contents/README.md?ref=main');
  check('merged content is readable on main', unb64(onMain.json?.content ?? '').includes('feature line'));

  // -- A conflicting pull request must refuse to merge (405)
  await call(base, 'POST', '/api/v3/repos/adaiversen/demo/git/refs', { ref: 'refs/heads/rival', sha: firstCommit });
  const rivalWrite = await call(base, 'PUT', '/api/v3/repos/adaiversen/demo/contents/README.md', {
    message: 'Rival edit',
    content: b64('# Demo\n\nhello rival\n'),
    branch: 'rival',
    sha: readBack.json?.sha,
  });
  check('contents write on the rival branch answers 200', rivalWrite.status === 200, `status ${rivalWrite.status}: ${rivalWrite.text}`);
  const rivalPull = await call(base, 'POST', '/api/v3/repos/adaiversen/demo/pulls', {
    title: 'Rival change',
    body: '',
    head: 'rival',
    base: 'main',
  });
  const rivalNumber = rivalPull.json?.number as number;
  check('rival pull creation answers 201', rivalPull.status === 201 && typeof rivalNumber === 'number', `status ${rivalPull.status}: ${rivalPull.text}`);
  const rivalMerge = await call(base, 'PUT', `/api/v3/repos/adaiversen/demo/pulls/${rivalNumber}/merge`, { merge_method: 'squash' });
  check('conflicting pull merge answers 405', rivalMerge.status === 405, `status ${rivalMerge.status}: ${rivalMerge.text}`);

  // -- GraphQL
  const gql = async (payload: unknown): Promise<Reply> =>
    call(base, 'POST', '/api/graphql', payload);
  const viewer = await gql({ query: '{ viewer { login } }' });
  check('GraphQL viewer login', viewer.json?.data?.viewer?.login === 'adaiversen', JSON.stringify(viewer.json));
  const repoDoc = await gql({
    query: 'query($o: String!, $n: String!) { repository(owner: $o, name: $n) { id databaseId defaultBranchRef { name } viewerPermission hasIssuesEnabled } }',
    variables: { o: 'adaiversen', n: 'demo' },
  });
  const repoData = repoDoc.json?.data?.repository;
  check(
    'GraphQL repository fields',
    repoData?.defaultBranchRef?.name === 'main' && repoData?.viewerPermission === 'ADMIN' && repoData?.hasIssuesEnabled === true && typeof repoData?.id === 'string',
    JSON.stringify(repoDoc.json),
  );
  const createdIssue = await gql({
    query: 'mutation($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }',
    variables: { input: { repositoryId: repoData?.id, title: 'From GraphQL', body: 'via mutation' } },
  });
  check('GraphQL createIssue numbers after the pulls', createdIssue.json?.data?.createIssue?.issue?.number === rivalNumber + 1, JSON.stringify(createdIssue.json));
  const batch = await gql([
    { query: '{ viewer { login } }' },
    { query: '{ repository(owner: "adaiversen", name: "demo") { name } }' },
  ]);
  check(
    'GraphQL batch answers an array in order',
    Array.isArray(batch.json) && batch.json[0]?.data?.viewer?.login === 'adaiversen' && batch.json[1]?.data?.repository?.name === 'demo',
    JSON.stringify(batch.json),
  );
  const invalid = await gql({ query: '{ viewer { noSuchFieldOnViewer } }' });
  check(
    'GraphQL invalid field answers errors naming the field',
    Array.isArray(invalid.json?.errors) && String(invalid.json.errors[0]?.message ?? '').includes('noSuchFieldOnViewer'),
    JSON.stringify(invalid.json),
  );
  const intro = await gql({
    query: '{ Issue: __type(name: "Issue") { fields { name } } SearchType: __type(name: "SearchType") { enumValues { name } } }',
  });
  const issueFields = (intro.json?.data?.Issue?.fields ?? []).map((f: any) => f.name);
  const searchValues = (intro.json?.data?.SearchType?.enumValues ?? []).map((v: any) => v.name);
  check(
    'GraphQL introspection covers Issue fields and SearchType',
    issueFields.includes('state') && issueFields.includes('body') && searchValues.includes('ISSUE'),
    JSON.stringify(intro.json),
  );

  // -- MCP
  const rpc = async (payload: unknown): Promise<Reply> => call(base, 'POST', '/mcp', payload);
  const discover = await rpc({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
  check(
    'MCP discover offers the modern era',
    Array.isArray(discover.json?.result?.supportedVersions) && discover.json.result.supportedVersions.includes('2026-07-28'),
    JSON.stringify(discover.json),
  );
  const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const toolNames = (tools.json?.result?.tools ?? []).map((t: any) => t.name);
  check(
    'MCP tools list has the six forge tools',
    ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'].every((n) => toolNames.includes(n)),
    toolNames.join(','),
  );
  const mcpIssue = await rpc({
    jsonrpc: '2.0',
    id: 'call-3',
    method: 'tools/call',
    params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'demo', title: 'From MCP', body: 'tool call' } },
  });
  check(
    'MCP create_issue echoes the id and returns the issue',
    mcpIssue.json?.id === 'call-3' && mcpIssue.json?.result?.structuredContent?.number === rivalNumber + 2 && mcpIssue.json?.result?.isError === false,
    JSON.stringify(mcpIssue.json),
  );
  const unknownTool = await rpc({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'delete_everything', arguments: {} },
  });
  check('MCP unknown tool is a JSON-RPC error, not a 500', unknownTool.status === 200 && unknownTool.json?.error?.code === -32602, JSON.stringify(unknownTool.json));

  // -- Git wire
  const gitHeaders = { authorization: `Bearer ${TOKEN}`, 'git-protocol': 'version=2' };
  const infoResponse = await fetch(`${base}/adaiversen/demo.git/info/refs?service=git-upload-pack`, { headers: gitHeaders });
  const infoBody = Buffer.from(await infoResponse.arrayBuffer());
  const firstPacket = unpkt(infoBody)[0];
  check(
    'git v2 advertisement opens with version 2',
    infoResponse.status === 200 && firstPacket?.kind === 'data' && firstPacket.payload.toString('utf8').startsWith('version 2'),
    `status ${infoResponse.status}`,
  );
  const lsRequest = Buffer.concat([
    pkt('command=ls-refs\n'),
    pkt('agent=selftest\n'),
    PKT_DELIM,
    pkt('peel\n'),
    pkt('symrefs\n'),
    PKT_FLUSH,
  ]);
  const lsResponse = await fetch(`${base}/adaiversen/demo.git/git-upload-pack`, {
    method: 'POST',
    headers: { ...gitHeaders, 'content-type': 'application/x-git-upload-pack-request' },
    body: lsRequest,
  });
  const lsBody = Buffer.from(await lsResponse.arrayBuffer());
  const lsText = unpkt(lsBody)
    .filter((packet) => packet.kind === 'data')
    .map((packet) => (packet.kind === 'data' ? packet.payload.toString('utf8') : ''))
    .join('');
  check('ls-refs lists main and the merged feature tip', lsText.includes('refs/heads/main') && lsText.includes('refs/heads/feature'), lsText);
  const repoNow = await call(base, 'GET', '/api/v3/repos/adaiversen/demo');
  void repoNow;
  const commits = await call(base, 'GET', '/api/v3/repos/adaiversen/demo/commits');
  const tip = Array.isArray(commits.json) ? (commits.json[0]?.sha as string) : '';
  const pushBody = Buffer.concat([
    pkt(`${'0'.repeat(40)} ${tip} refs/heads/pushed\0report-status side-band-64k`),
    PKT_FLUSH,
    writePack(new Map(), []),
  ]);
  const pushResponse = await fetch(`${base}/adaiversen/demo.git/git-receive-pack`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-git-receive-pack-request' },
    body: pushBody,
  });
  const pushText = Buffer.from(await pushResponse.arrayBuffer()).toString('latin1');
  check('receive-pack creates a branch and reports ok', pushResponse.status === 200 && pushText.includes('ok refs/heads/pushed'), pushText);
  const afterPush = await call(base, 'GET', '/api/v3/repos/adaiversen/demo/branches');
  const namesAfter = Array.isArray(afterPush.json) ? afterPush.json.map((b: any) => b.name) : [];
  check('the pushed branch is visible over REST', namesAfter.includes('pushed'), namesAfter.join(','));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
