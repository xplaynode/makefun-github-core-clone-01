// The GraphQL v4 surface at /api/graphql. The clients that matter (gh and
// github-mcp-server) send a fixed family of documents, so this is a small
// complete implementation of the GraphQL core they exercise: operations
// with variables, aliases, fragments, inline fragments, list and object
// literals, connection pagination by opaque cursor, batching (an array of
// documents answers an array of results), and __type/__schema
// introspection. Invalid fields answer HTTP 200 with an errors array whose
// message names the field, matching GitHub's behavior.

import { diffTrees } from './merge.ts';
import {
  ACCOUNT,
  addComment,
  commentGlobalId,
  createIssue,
  createPull,
  filesAtCommit,
  issueGlobalId,
  mergePull,
  openPullFor,
  parseGlobalId,
  pullGlobalId,
  pullMergeBase,
  pullMergeable,
  repoGlobalId,
  userGlobalId,
  type CommentRec,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

export type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

export interface GqlField {
  name: string;
  alias?: string;
  args: Map<string, GqlValue>;
  selections: GqlField[];
  fragmentType?: string;
  isSpread?: string;
}

interface GqlOperation {
  type: 'query' | 'mutation';
  name?: string;
  selections: GqlField[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlField[]>;
}

// ---------------------------------------------------------------------------
// Lexer

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === '/' ? '/' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc === 'u' ? String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16)) : esc;
          j += esc === 'u' ? 6 : 2;
        } else {
          out += source[j];
          j++;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) {
        if (source[j] === '.') isFloat = true;
        j++;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j++;
        if (source[j] === '+' || source[j] === '-') j++;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j++;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    return this.tokens[this.pos++] as Token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}", got "${token.value}"`);
  }
  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got "${token.value}"`);
    return token.value;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlField[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (this.atPunct('{')) {
        operations.push({ type: 'query', selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token "${token.value}"`);
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.atPunct('(')) this.skipBalancedParens(); // variable definitions
        this.skipDirectives();
        operations.push({
          type: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onKeyword = this.expectName();
        if (onKeyword !== 'on') throw new Error('expected "on" in fragment definition');
        this.expectName(); // the type condition
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      // Schema/type/extension definitions are not executable documents here.
      throw new Error(`unsupported definition "${token.value}"`);
    }
    return { operations, fragments };
  }

  private skipBalancedParens(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unbalanced parentheses');
      if (token.kind === 'punct' && token.value === '(') depth++;
      if (token.kind === 'punct' && token.value === ')') depth--;
    } while (depth > 0);
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) this.skipBalancedParens();
    }
  }

  parseSelectionSet(): GqlField[] {
    this.expectPunct('{');
    const fields: GqlField[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      fields.push(this.parseSelection());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseSelection(): GqlField {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.atPunct('{')) {
        return { name: '', args: new Map(), selections: this.parseSelectionSet() };
      }
      const name = this.expectName();
      if (name === 'on') {
        const type = this.expectName();
        this.skipDirectives();
        return { name: '', args: new Map(), selections: this.parseSelectionSet(), fragmentType: type };
      }
      this.skipDirectives();
      return { name: '', args: new Map(), selections: [], isSpread: name };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, GqlValue>();
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selections = this.atPunct('{') ? this.parseSelectionSet() : [];
    return { name, alias, args, selections };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, GqlValue>();
      while (!this.atPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields.set(key, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token "${token.value}"`);
  }
}

/** Evaluate a literal/variable value node against the variable map. */
export function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) {
        const resolved = resolveValue(entry, variables);
        if (resolved !== undefined) out[key] = resolved;
      }
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema

interface FieldDef {
  type: string;
  args?: Record<string, string>;
}

interface TypeDef {
  kind: 'OBJECT' | 'INTERFACE' | 'SCALAR' | 'ENUM' | 'INPUT_OBJECT';
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
  inputFields?: Record<string, string>;
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'Viewer!' },
      repository: { type: 'Repository', args: { owner: 'String!', name: 'String!' } },
      node: { type: 'Node', args: { id: 'ID!' } },
      __type: { type: '__Type', args: { name: 'String!' } },
      __schema: { type: '__Schema' },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: 'CreateIssuePayload', args: { input: 'CreateIssueInput!' } },
      closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput!' } },
      createPullRequest: { type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput!' } },
      mergePullRequest: { type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput!' } },
      addComment: { type: 'AddCommentPayload', args: { input: 'AddCommentInput!' } },
    },
  },
  Viewer: {
    kind: 'OBJECT',
    fields: { login: { type: 'String!' }, id: { type: 'ID!' }, name: { type: 'String' }, email: { type: 'String' } },
  },
  Node: { kind: 'INTERFACE', fields: { id: { type: 'ID!' } } },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int' },
      name: { type: 'String!' },
      nameWithOwner: { type: 'String!' },
      owner: { type: 'RepositoryOwner!' },
      description: { type: 'String' },
      isPrivate: { type: 'Boolean!' },
      defaultBranchRef: { type: 'Ref' },
      viewerPermission: { type: 'RepositoryPermission' },
      hasIssuesEnabled: { type: 'Boolean!' },
      issue: { type: 'Issue', args: { number: 'Int!' } },
      issues: {
        type: 'IssueConnection!',
        args: { first: 'Int', after: 'String', states: '[IssueState!]', orderBy: 'IssueOrder' },
      },
      pullRequest: { type: 'PullRequest', args: { number: 'Int!' } },
      pullRequests: {
        type: 'PullRequestConnection!',
        args: { first: 'Int', after: 'String', states: '[PullRequestState!]' },
      },
    },
  },
  RepositoryOwner: { kind: 'OBJECT', fields: { login: { type: 'String!' }, id: { type: 'ID!' } } },
  Ref: { kind: 'OBJECT', fields: { name: { type: 'String!' }, prefix: { type: 'String!' } } },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      state: { type: 'IssueState!' },
      body: { type: 'String!' },
      repository: { type: 'Repository!' },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      body: { type: 'String' },
      state: { type: 'PullRequestState!' },
      merged: { type: 'Boolean!' },
      headRefName: { type: 'String!' },
      baseRefName: { type: 'String!' },
      mergeable: { type: 'MergeableState!' },
      repository: { type: 'Repository!' },
      files: { type: 'PullRequestChangedFileConnection', args: { first: 'Int', after: 'String' } },
    },
  },
  IssueComment: { kind: 'OBJECT', fields: { id: { type: 'ID!' }, body: { type: 'String!' } } },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean!' },
      hasPreviousPage: { type: 'Boolean!' },
      startCursor: { type: 'String' },
      endCursor: { type: 'String' },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Issue]' },
      edges: { type: '[IssueEdge]' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  IssueEdge: { kind: 'OBJECT', fields: { node: { type: 'Issue' }, cursor: { type: 'String!' } } },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequest]' },
      edges: { type: '[PullRequestEdge]' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  PullRequestEdge: { kind: 'OBJECT', fields: { node: { type: 'PullRequest' }, cursor: { type: 'String!' } } },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: { path: { type: 'String!' }, additions: { type: 'Int!' }, deletions: { type: 'Int!' } },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequestChangedFile]' },
      edges: { type: '[PullRequestChangedFileEdge]' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  PullRequestChangedFileEdge: {
    kind: 'OBJECT',
    fields: { node: { type: 'PullRequestChangedFile' }, cursor: { type: 'String!' } },
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } },
  },
  AddCommentPayload: { kind: 'OBJECT', fields: { commentEdge: { type: 'IssueCommentEdge' }, clientMutationId: { type: 'String' } } },
  IssueCommentEdge: { kind: 'OBJECT', fields: { node: { type: 'IssueComment' }, cursor: { type: 'String!' } } },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrder: { kind: 'INPUT_OBJECT', inputFields: { field: 'IssueOrderField', direction: 'OrderDirection' } },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { repositoryId: 'ID!', title: 'String!', body: 'String', clientMutationId: 'String' },
  },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: 'ID!', clientMutationId: 'String' } },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: {
      repositoryId: 'ID!',
      baseRefName: 'String!',
      headRefName: 'String!',
      title: 'String!',
      body: 'String',
      clientMutationId: 'String',
    },
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', clientMutationId: 'String' },
  },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' },
  },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      types: { type: '[__Type!]!' },
      queryType: { type: '__Type!' },
      mutationType: { type: '__Type' },
      subscriptionType: { type: '__Type' },
      directives: { type: '[__Directive!]!' },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      kind: { type: '__TypeKind!' },
      name: { type: 'String' },
      description: { type: 'String' },
      fields: { type: '[__Field!]', args: { includeDeprecated: 'Boolean' } },
      inputFields: { type: '[__InputValue!]' },
      interfaces: { type: '[__Type!]!' },
      enumValues: { type: '[__EnumValue!]', args: { includeDeprecated: 'Boolean' } },
      possibleTypes: { type: '[__Type!]' },
      ofType: { type: '__Type' },
      specifiedByURL: { type: 'String' },
    },
  },
  __TypeKind: { kind: 'ENUM', enumValues: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      args: { type: '[__InputValue!]!' },
      type: { type: '__Type!' },
      isDeprecated: { type: 'Boolean!' },
      deprecationReason: { type: 'String' },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      isDeprecated: { type: 'Boolean!' },
      deprecationReason: { type: 'String' },
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      type: { type: '__Type!' },
      defaultValue: { type: 'String' },
    },
  },
  __Directive: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      locations: { type: '[__DirectiveLocation!]!' },
      args: { type: '[__InputValue!]!' },
      isRepeatable: { type: 'Boolean!' },
    },
  },
  __DirectiveLocation: { kind: 'ENUM', enumValues: ['QUERY', 'MUTATION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'] },
};

/** Strip list/non-null wrappers to the named type. */
function namedType(ref: string): string {
  return ref.replace(/[\[\]!]/g, '');
}

function typeRefObject(ref: string): Record<string, unknown> {
  if (ref.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: typeRefObject(ref.slice(0, -1)) };
  if (ref.startsWith('[') && ref.endsWith(']')) return { kind: 'LIST', name: null, ofType: typeRefObject(ref.slice(1, -1)) };
  const def = SCHEMA[ref];
  return { kind: def?.kind ?? 'SCALAR', name: ref, ofType: null };
}

// ---------------------------------------------------------------------------
// Executor

type Source = Record<string, unknown> & { __type: string };

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, GqlField[]>;
  errors: { message: string }[];
}

const viewerValue = (): Source => ({ __type: 'Viewer' });
const repoValue = (repo: RepoRec): Source => ({ __type: 'Repository', repo });
const issueValue = (repo: RepoRec, issue: IssueRec): Source => ({ __type: 'Issue', repo, issue });
const pullValue = (repo: RepoRec, pull: PullRec): Source => ({ __type: 'PullRequest', repo, pull });

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function parseCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
    return match ? Number.parseInt(match[1] as string, 10) : null;
  } catch {
    return null;
  }
}

interface ConnEntry {
  value: Source;
  cursor: string;
}

function buildConnection(
  typeName: string,
  all: Source[],
  first: unknown,
  after: unknown,
): Source {
  let start = 0;
  const afterIndex = parseCursor(after);
  if (afterIndex !== null) start = afterIndex + 1;
  const size = typeof first === 'number' && Number.isFinite(first) && first >= 0 ? Math.floor(first) : all.length;
  const slice = all.slice(start, start + size);
  const entries: ConnEntry[] = slice.map((value, i) => ({ value, cursor: cursorFor(start + i) }));
  return {
    __type: typeName,
    entries,
    totalCount: all.length,
    hasNextPage: start + slice.length < all.length,
    hasPreviousPage: start > 0,
    startCursor: entries[0]?.cursor ?? null,
    endCursor: entries[entries.length - 1]?.cursor ?? null,
  };
}

function argOf(ctx: ExecCtx, field: GqlField, name: string): unknown {
  const raw = field.args.get(name);
  return raw === undefined ? undefined : resolveValue(raw, ctx.variables);
}

function repoOf(source: Source): RepoRec {
  return source.repo as RepoRec;
}

// Introspection values are plain objects tagged with their meta type; the
// fields are read back out of the schema table on demand.
function introTypeValue(name: string): Source | null {
  const def = SCHEMA[name];
  if (def === undefined) return null;
  return { __type: '__Type', name, def };
}

function resolveIntro(typeName: string, source: Source, field: GqlField): unknown {
  if (typeName === '__Type') {
    const raw = source.raw as { kind: string; name: string | null; ofType: unknown } | undefined;
    if (raw !== undefined) {
      // A structural type reference (NON_NULL / LIST wrapper or a named type
      // reached through one): only kind, name and ofType are meaningful.
      if (field.name === 'kind') return raw.kind;
      if (field.name === 'name') return raw.name;
      if (field.name === 'ofType') return raw.ofType === null ? null : { __type: '__Type', raw: raw.ofType };
      if (field.name === 'interfaces') return [];
      return null;
    }
    const def = source.def as TypeDef;
    const name = source.name as string;
    switch (field.name) {
      case 'kind':
        return def.kind;
      case 'name':
        return name;
      case 'description':
        return null;
      case 'fields': {
        if (def.fields === undefined) return null;
        return Object.entries(def.fields).map(([fieldName, fieldDef]) => ({
          __type: '__Field',
          name: fieldName,
          def: fieldDef,
        }));
      }
      case 'inputFields': {
        if (def.inputFields === undefined) return null;
        return Object.entries(def.inputFields).map(([inputName, ref]) => ({
          __type: '__InputValue',
          name: inputName,
          ref,
        }));
      }
      case 'interfaces':
        return [];
      case 'enumValues': {
        if (def.enumValues === undefined) return null;
        return def.enumValues.map((value) => ({ __type: '__EnumValue', name: value }));
      }
      case 'possibleTypes':
        return null;
      case 'ofType':
        return null;
      case 'specifiedByURL':
        return null;
      default:
        return null;
    }
  }
  if (typeName === '__Field') {
    const def = source.def as FieldDef;
    switch (field.name) {
      case 'name':
        return source.name;
      case 'description':
        return null;
      case 'args':
        return Object.entries(def.args ?? {}).map(([argName, ref]) => ({ __type: '__InputValue', name: argName, ref }));
      case 'type':
        return { __type: '__Type', raw: typeRefObject(def.type) };
      case 'isDeprecated':
        return false;
      case 'deprecationReason':
        return null;
      default:
        return null;
    }
  }
  if (typeName === '__EnumValue') {
    if (field.name === 'name') return source.name;
    if (field.name === 'isDeprecated') return false;
    return null;
  }
  if (typeName === '__InputValue') {
    if (field.name === 'name') return source.name;
    if (field.name === 'type') return { __type: '__Type', raw: typeRefObject(source.ref as string) };
    return null;
  }
  if (typeName === '__Schema') {
    switch (field.name) {
      case 'types':
        return Object.keys(SCHEMA)
          .map((name) => introTypeValue(name))
          .filter((value) => value !== null);
      case 'queryType':
        return introTypeValue('Query');
      case 'mutationType':
        return introTypeValue('Mutation');
      case 'subscriptionType':
        return null;
      case 'directives':
        return ['include', 'skip', 'deprecated', 'specifiedBy'].map((name) => ({
          __type: '__Directive',
          name,
        }));
      default:
        return null;
    }
  }
  if (typeName === '__Directive') {
    if (field.name === 'name') return source.name;
    if (field.name === 'locations') return [];
    if (field.name === 'args') return [];
    if (field.name === 'isRepeatable') return false;
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Business resolvers

function resolveNode(ctx: ExecCtx, id: unknown): Source | null {
  if (typeof id !== 'string') return null;
  const parts = parseGlobalId(id);
  if (parts === null) return null;
  const [kind, first, second] = parts as [string, string | undefined, string | undefined];
  if (kind === 'Repository') {
    const repo = ctx.forge.repoByDbId(Number.parseInt(first ?? '', 10));
    return repo === undefined ? null : repoValue(repo);
  }
  if (kind === 'Issue' || kind === 'PullRequest') {
    const repo = ctx.forge.repoByDbId(Number.parseInt(first ?? '', 10));
    if (repo === undefined) return null;
    const number = Number.parseInt(second ?? '', 10);
    if (kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueValue(repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullValue(repo, pull);
  }
  if (kind === 'User') return viewerValue();
  return null;
}

function stateFilter(values: Source[], field: GqlField, ctx: ExecCtx, stateOf: (value: Source) => string): Source[] {
  const states = argOf(ctx, field, 'states');
  if (!Array.isArray(states) || states.length === 0) return values;
  const wanted = new Set(states.map((entry) => String(entry)));
  return values.filter((value) => wanted.has(stateOf(value)));
}

function resolveBusiness(ctx: ExecCtx, typeName: string, source: Source, field: GqlField): unknown {
  const { forge } = ctx;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return viewerValue();
      if (field.name === 'repository') {
        const owner = argOf(ctx, field, 'owner');
        const name = argOf(ctx, field, 'name');
        const repo = typeof owner === 'string' && typeof name === 'string' ? forge.getRepo(owner, name) : undefined;
        return repo === undefined ? null : repoValue(repo);
      }
      if (field.name === 'node') return resolveNode(ctx, argOf(ctx, field, 'id'));
      return null;
    }
    case 'Viewer': {
      if (field.name === 'login') return ACCOUNT.login;
      if (field.name === 'id') return userGlobalId();
      if (field.name === 'name') return ACCOUNT.name;
      if (field.name === 'email') return ACCOUNT.email;
      return null;
    }
    case 'Repository': {
      const repo = repoOf(source);
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.dbId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { __type: 'RepositoryOwner', login: repo.owner };
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : { __type: 'Ref', name: repo.defaultBranch };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = argOf(ctx, field, 'number');
          const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
          return issue === undefined ? null : issueValue(repo, issue);
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          const orderBy = argOf(ctx, field, 'orderBy');
          const direction =
            typeof orderBy === 'object' && orderBy !== null ? (orderBy as Record<string, unknown>).direction : undefined;
          issues.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
          const values = stateFilter(
            issues.map((issue) => issueValue(repo, issue)),
            field,
            ctx,
            (value) => ((value.issue as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED'),
          );
          return buildConnection('IssueConnection', values, argOf(ctx, field, 'first'), argOf(ctx, field, 'after'));
        }
        case 'pullRequest': {
          const number = argOf(ctx, field, 'number');
          const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
          return pull === undefined ? null : pullValue(repo, pull);
        }
        case 'pullRequests': {
          const pulls = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
          const values = stateFilter(
            pulls.map((pull) => pullValue(repo, pull)),
            field,
            ctx,
            (value) => {
              const pull = value.pull as PullRec;
              return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
            },
          );
          return buildConnection('PullRequestConnection', values, argOf(ctx, field, 'first'), argOf(ctx, field, 'after'));
        }
        default:
          return null;
      }
    }
    case 'RepositoryOwner': {
      if (field.name === 'login') return source.login;
      if (field.name === 'id') return userGlobalId();
      return null;
    }
    case 'Ref': {
      if (field.name === 'name') return source.name;
      if (field.name === 'prefix') return 'refs/heads/';
      return null;
    }
    case 'Issue': {
      const repo = repoOf(source);
      const issue = source.issue as IssueRec;
      switch (field.name) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'repository':
          return repoValue(repo);
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const repo = repoOf(source);
      const pull = source.pull as PullRec;
      switch (field.name) {
        case 'id':
          return pullGlobalId(repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'repository':
          return repoValue(repo);
        case 'files':
          return filesConnection(ctx, repo, pull, field);
        default:
          return null;
      }
    }
    case 'IssueComment': {
      const comment = source.comment as CommentRec;
      const repo = repoOf(source);
      if (field.name === 'id') return commentGlobalId(repo, source.number as number, comment);
      if (field.name === 'body') return comment.body;
      return null;
    }
    default:
      return resolveConnectionField(typeName, source, field);
  }
}

function filesConnection(ctx: ExecCtx, repo: RepoRec, pull: PullRec, field: GqlField): Source {
  const base = pullMergeBase(repo, pull);
  const ancestorFiles = base === null ? new Map<string, string>() : filesAtCommit(repo, base);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const headFiles = filesAtCommit(repo, headTip);
  const changes = diffTrees(repo.objects, ancestorFiles, headFiles);
  const values: Source[] = changes.map((change) => ({
    __type: 'PullRequestChangedFile',
    path: change.filename,
    additions: change.additions,
    deletions: change.deletions,
  }));
  return buildConnection('PullRequestChangedFileConnection', values, argOf(ctx, field, 'first'), argOf(ctx, field, 'after'));
}

function resolveConnectionField(typeName: string, source: Source, field: GqlField): unknown {
  if (typeName.endsWith('Connection')) {
    const entries = source.entries as ConnEntry[];
    switch (field.name) {
      case 'nodes':
        return entries.map((entry) => entry.value);
      case 'edges':
        return entries.map((entry) => ({
          __type: `${typeName.replace(/Connection$/, '')}Edge`,
          node: entry.value,
          cursor: entry.cursor,
        }));
      case 'pageInfo':
        return {
          __type: 'PageInfo',
          hasNextPage: source.hasNextPage,
          hasPreviousPage: source.hasPreviousPage,
          startCursor: source.startCursor,
          endCursor: source.endCursor,
        };
      case 'totalCount':
        return source.totalCount;
      default:
        return null;
    }
  }
  if (typeName.endsWith('Edge')) {
    if (field.name === 'node') return source.node;
    if (field.name === 'cursor') return source.cursor;
    return null;
  }
  if (typeName === 'PageInfo') {
    return (source as Record<string, unknown>)[field.name] ?? null;
  }
  if (typeName === 'PullRequestChangedFile') {
    return (source as Record<string, unknown>)[field.name] ?? null;
  }
  if (typeName.endsWith('Payload')) {
    return (source as Record<string, unknown>)[field.name] ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mutations

function inputOf(ctx: ExecCtx, field: GqlField): Record<string, unknown> {
  const input = argOf(ctx, field, 'input');
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function repoFromGlobal(ctx: ExecCtx, id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const parts = parseGlobalId(id);
  if (parts === null || parts[0] !== 'Repository') return null;
  return ctx.forge.repoByDbId(Number.parseInt(parts[1] ?? '', 10)) ?? null;
}

function resolveMutation(ctx: ExecCtx, field: GqlField): unknown {
  const { forge } = ctx;
  const input = inputOf(ctx, field);
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
  switch (field.name) {
    case 'createIssue': {
      const payload = (issue: Source | null): Source => ({ __type: 'CreateIssuePayload', issue, clientMutationId });
      const repo = repoFromGlobal(ctx, input.repositoryId);
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve the repository for createIssue' });
        return payload(null);
      }
      const title = input.title;
      if (typeof title !== 'string' || title === '') {
        ctx.errors.push({ message: 'Title is required to create an issue' });
        return payload(null);
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = createIssue(forge, repo, title, body, []);
      return payload(issueValue(repo, issue));
    }
    case 'closeIssue': {
      const payload = (issue: Source | null): Source => ({ __type: 'CloseIssuePayload', issue, clientMutationId });
      const target = resolveNode(ctx, input.issueId);
      if (target === null || target.__type !== 'Issue') {
        ctx.errors.push({ message: 'Could not resolve the issue for closeIssue' });
        return payload(null);
      }
      const issue = target.issue as IssueRec;
      issue.state = 'closed';
      return payload(target);
    }
    case 'createPullRequest': {
      const payload = (pull: Source | null): Source => ({ __type: 'CreatePullRequestPayload', pullRequest: pull, clientMutationId });
      const repo = repoFromGlobal(ctx, input.repositoryId);
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve the repository for createPullRequest' });
        return payload(null);
      }
      const head = input.headRefName;
      const base = input.baseRefName;
      const title = input.title;
      if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') {
        ctx.errors.push({ message: 'headRefName, baseRefName and title are required' });
        return payload(null);
      }
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (headTip === undefined || baseTip === undefined) {
        ctx.errors.push({ message: 'The head or base branch does not exist' });
        return payload(null);
      }
      if (headTip === baseTip) {
        ctx.errors.push({ message: `No commits between ${base} and ${head}` });
        return payload(null);
      }
      if (openPullFor(repo, head, base) !== undefined) {
        ctx.errors.push({ message: `A pull request already exists for ${head} into ${base}` });
        return payload(null);
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const pull = createPull(forge, repo, head, base, title, body);
      return payload(pullValue(repo, pull));
    }
    case 'mergePullRequest': {
      const payload = (pull: Source | null): Source => ({ __type: 'MergePullRequestPayload', pullRequest: pull, clientMutationId });
      const target = resolveNode(ctx, input.pullRequestId);
      if (target === null || target.__type !== 'PullRequest') {
        ctx.errors.push({ message: 'Could not resolve the pull request for mergePullRequest' });
        return payload(null);
      }
      const repo = repoOf(target);
      const pull = target.pull as PullRec;
      if (pull.state !== 'open') {
        ctx.errors.push({ message: 'Pull Request is not mergeable' });
        return payload(target);
      }
      const methodField = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
      const method = methodField === 'MERGE' ? 'merge' : methodField === 'REBASE' ? 'rebase' : 'squash';
      const result = mergePull(forge, repo, pull, method);
      if (!result.ok) {
        ctx.errors.push({ message: result.detail });
        return payload(target);
      }
      return payload(pullValue(repo, pull));
    }
    case 'addComment': {
      const payload = (edge: Source | null): Source => ({ __type: 'AddCommentPayload', commentEdge: edge, clientMutationId });
      const target = resolveNode(ctx, input.subjectId);
      if (target === null || (target.__type !== 'Issue' && target.__type !== 'PullRequest')) {
        ctx.errors.push({ message: 'Could not resolve the subject for addComment' });
        return payload(null);
      }
      const body = input.body;
      if (typeof body !== 'string' || body === '') {
        ctx.errors.push({ message: 'Body is required to add a comment' });
        return payload(null);
      }
      const repo = repoOf(target);
      const number = (target.__type === 'Issue' ? (target.issue as IssueRec).number : (target.pull as PullRec).number);
      const comment = addComment(forge, repo, number, body);
      const node: Source = { __type: 'IssueComment', repo, number, comment };
      return payload({ __type: 'IssueCommentEdge', node, cursor: cursorFor(0) });
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Completion

function expandSelections(ctx: ExecCtx, selections: GqlField[], typeName: string): GqlField[] {
  const out: GqlField[] = [];
  for (const selection of selections) {
    if (selection.isSpread !== undefined) {
      const fragment = ctx.fragments.get(selection.isSpread);
      if (fragment !== undefined) out.push(...expandSelections(ctx, fragment, typeName));
      continue;
    }
    if (selection.name === '') {
      if (selection.fragmentType === undefined || selection.fragmentType === typeName) {
        out.push(...expandSelections(ctx, selection.selections, typeName));
      }
      continue;
    }
    out.push(selection);
  }
  return out;
}

function completeValue(ctx: ExecCtx, ref: string, value: unknown, field: GqlField): unknown {
  if (ref.endsWith('!')) return completeValue(ctx, ref.slice(0, -1), value, field);
  if (value === null || value === undefined) return null;
  if (ref.startsWith('[') && ref.endsWith(']')) {
    const inner = ref.slice(1, -1);
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => completeValue(ctx, inner, item, field));
  }
  const name = namedType(ref);
  const def = SCHEMA[name];
  if (def === undefined || def.kind === 'SCALAR' || def.kind === 'ENUM') return value;
  const source = value as Source;
  const actualType = typeof source.__type === 'string' ? source.__type : name;
  return execSelections(ctx, actualType, source, field.selections);
}

function execSelections(ctx: ExecCtx, typeName: string, source: Source, selections: GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of expandSelections(ctx, selections, typeName)) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (typeName === 'Query' && field.name === '__type') {
      const nameArg = argOf(ctx, field, 'name');
      out[key] = completeValue(ctx, '__Type', typeof nameArg === 'string' ? introTypeValue(nameArg) : null, field);
      continue;
    }
    if (typeName === 'Query' && field.name === '__schema') {
      out[key] = completeValue(ctx, '__Schema', { __type: '__Schema' } as Source, field);
      continue;
    }
    const fieldDef = SCHEMA[typeName]?.fields?.[field.name];
    if (fieldDef === undefined) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const raw =
      typeName === 'Mutation'
        ? resolveMutation(ctx, field)
        : typeName.startsWith('__')
          ? resolveIntro(typeName, source, field)
          : resolveBusiness(ctx, typeName, source, field);
    out[key] = completeValue(ctx, fieldDef.type, raw, field);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point

function executeOne(forge: Forge, entry: unknown): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { errors: [{ message: 'GraphQL request must be an object with a query string' }] };
  }
  const record = entry as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string') return { errors: [{ message: 'Must provide query string.' }] };
  let variables: Record<string, unknown> = {};
  if (typeof record.variables === 'object' && record.variables !== null) {
    variables = record.variables as Record<string, unknown>;
  } else if (typeof record.variables === 'string') {
    try {
      const parsed: unknown = JSON.parse(record.variables);
      if (typeof parsed === 'object' && parsed !== null) variables = parsed as Record<string, unknown>;
    } catch {
      variables = {};
    }
  }
  let document: GqlDocument;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
  const operation =
    (operationName !== undefined ? document.operations.find((op) => op.name === operationName) : undefined) ??
    document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found in the document' }] };
  const ctx: ExecCtx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = execSelections(ctx, rootType, { __type: rootType }, operation.selections);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Handle one GraphQL POST body: a single document, or an array (batch). */
export function handleGraphql(forge: Forge, payload: unknown): { status: number; json: unknown } {
  if (Array.isArray(payload)) {
    return { status: 200, json: payload.map((entry) => executeOne(forge, entry)) };
  }
  return { status: 200, json: executeOne(forge, payload) };
}
