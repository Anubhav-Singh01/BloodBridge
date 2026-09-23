// Offline scanner for migration SQL (Batch 3.5). Pure: no I/O, no environment, no connection, no eval.
//
// The runner sends nothing to a database unless every statement of every migration passes this scanner first.
// It is a positive allow-list that fails closed: a statement is accepted only if it matches one of a few exact shapes,
// and the SQL embedded in a statement (function bodies, CHECK and DEFAULT expressions, index predicates, view bodies,
// trigger targets) is checked as well, because "CREATE FUNCTION" or "CREATE TABLE" alone says nothing about what the
// statement can execute. Anything not recognised is refused, including harmless constructs. To accept a new construct,
// add a rule here and a test in the same change.

export type ScanLayer = 'chunk' | 'shape' | 'tokenizer' | 'grammar' | 'deny-net' | 'statement';

export class ScanError extends Error {
  readonly layer: ScanLayer;
  constructor(layer: ScanLayer, message: string) {
    super(message);
    this.name = 'ScanError';
    this.layer = layer;
  }
}

function fail(layer: ScanLayer, message: string): never {
  throw new ScanError(layer, message);
}

export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

// ---------------------------------------------------------------------------------------------------------------------
// Allow-lists. Each is the least the real migrations need. Everything else is refused.

/** Functions a trigger function body may call. */
export const BODY_FUNCTIONS: ReadonlySet<string> = new Set(['now', 'to_jsonb']);
/** Error codes a trigger function may raise. */
export const BODY_ERRCODES: ReadonlySet<string> = new Set(['integrity_constraint_violation', 'foreign_key_violation']);
const BODY_TYPES: ReadonlySet<string> = new Set(['uuid', 'boolean']);
/** Functions an embedded expression (CHECK, DEFAULT, EXCLUDE, index predicate) may call. */
export const DDL_FUNCTIONS: ReadonlySet<string> = new Set(['btrim', 'cardinality', 'daterange', 'gen_random_uuid', 'jsonb_typeof', 'length', 'now']);
// Words that are followed by "(" only because of SQL grammar, never a call.
const DDL_SYNTAX: ReadonlySet<string> = new Set(['UNIQUE', 'KEY', 'CHECK', 'IN', 'ANY', 'AND', 'OR', 'NOT', 'WHERE', 'DISTINCT']);
const INDEX_METHODS: ReadonlySet<string> = new Set(['btree', 'gist', 'gin']);
const EXTENSIONS: ReadonlySet<string> = new Set(['postgis', 'btree_gist']);
const MAX_BODY_TOKENS = 4000;
const MAX_BODY_DEPTH = 12;
const MAX_BODY_CHARS = 20_000;

// ---------------------------------------------------------------------------------------------------------------------
// Tokenizer. Fails closed on anything unusual.

export type TokenType = 'WORD' | 'QIDENT' | 'STR' | 'NUM' | 'PUNCT' | 'OP';

export interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
}

export interface LexOptions {
  /** Statement mode: also accept quoted identifiers, [ ] and the extra operator characters DDL uses. */
  ddl?: boolean;
}

const OPERATOR_CHARS = '+-*/<>=~!@#%^&|?:';
const STRICT_TWO_CHAR_OPERATORS = [':=', '::', '<>', '<=', '>=', '!=', '||'];

export function lex(source: string, layer: ScanLayer, options: LexOptions = {}): Token[] {
  const ddl = options.ddl === true;
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source.charAt(i);
    const code = source.charCodeAt(i);
    if (code === 0) fail(layer, 'NUL byte');
    if (code > 126) fail(layer, 'non-ASCII character');
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    if (c === '-' && source.charAt(i + 1) === '-') {
      while (i < n && source.charAt(i) !== '\n') i += 1;
      continue;
    }
    if (c === '/' && source.charAt(i + 1) === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (source.charAt(i) === '/' && source.charAt(i + 1) === '*') {
          depth += 1;
          i += 2;
        } else if (source.charAt(i) === '*' && source.charAt(i + 1) === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (depth > 0) fail(layer, 'unterminated block comment');
      continue;
    }
    if (c === "'") {
      const previous = tokens[tokens.length - 1];
      if (previous && previous.type === 'WORD' && previous.end === i && /^(e|u|b|x|n)$/i.test(previous.text)) {
        fail(layer, 'prefixed string literal (E, U&, B, X, N)');
      }
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= n) fail(layer, 'unterminated string');
        const d = source.charAt(j);
        const dc = source.charCodeAt(j);
        if (dc > 126 || dc === 0) fail(layer, 'non-ASCII or NUL inside a string');
        if (d === "'") {
          if (source.charAt(j + 1) === "'") {
            value += "'";
            j += 2;
            continue;
          }
          break;
        }
        value += d;
        j += 1;
      }
      tokens.push({ type: 'STR', text: value, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      if (!ddl) fail(layer, 'double-quoted identifier');
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= n) fail(layer, 'unterminated quoted identifier');
        const d = source.charAt(j);
        const dc = source.charCodeAt(j);
        if (dc > 126 || dc < 32) fail(layer, 'unusual character inside a quoted identifier');
        if (d === '"') {
          if (source.charAt(j + 1) === '"') {
            value += '"';
            j += 2;
            continue;
          }
          break;
        }
        value += d;
        j += 1;
      }
      if (value === '') fail(layer, 'empty quoted identifier');
      tokens.push({ type: 'QIDENT', text: value, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (c === '$') fail(layer, 'dollar sign (dollar quoting or a parameter)');
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(source.charAt(j))) j += 1;
      tokens.push({ type: 'WORD', text: source.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(source.charAt(j))) j += 1;
      tokens.push({ type: 'NUM', text: source.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (c === '(' || c === ')' || c === ',' || c === ';' || c === '.' || (ddl && (c === '[' || c === ']'))) {
      tokens.push({ type: 'PUNCT', text: c, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ddl && OPERATOR_CHARS.includes(c)) {
      let j = i;
      while (j < n && OPERATOR_CHARS.includes(source.charAt(j))) {
        if (source.charAt(j) === '-' && source.charAt(j + 1) === '-') break;
        if (source.charAt(j) === '/' && source.charAt(j + 1) === '*') break;
        j += 1;
      }
      tokens.push({ type: 'OP', text: source.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (STRICT_TWO_CHAR_OPERATORS.includes(two)) {
      tokens.push({ type: 'OP', text: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if ('+-*/<>='.includes(c)) {
      tokens.push({ type: 'OP', text: c, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    fail(layer, `unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

class Cursor {
  pos = 0;
  constructor(
    readonly tokens: readonly Token[],
    readonly layer: ScanLayer,
  ) {}

  peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }
  upper(offset = 0): string {
    const t = this.peek(offset);
    return t?.type === 'WORD' ? t.text.toUpperCase() : '';
  }
  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }
  describe(): string {
    return this.peek()?.text ?? 'the end of the statement';
  }
  eatWord(word: string): boolean {
    if (this.upper() !== word) return false;
    this.pos += 1;
    return true;
  }
  needWord(word: string): void {
    if (!this.eatWord(word)) fail(this.layer, `expected ${word}, found ${this.describe()}`);
  }
  isPunct(text: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t?.type === 'PUNCT' && t.text === text;
  }
  eatPunct(text: string): boolean {
    if (!this.isPunct(text)) return false;
    this.pos += 1;
    return true;
  }
  needPunct(text: string): void {
    if (!this.eatPunct(text)) fail(this.layer, `expected "${text}", found ${this.describe()}`);
  }
  isOp(text: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t?.type === 'OP' && t.text === text;
  }
  eatOp(text: string): boolean {
    if (!this.isOp(text)) return false;
    this.pos += 1;
    return true;
  }
  needOp(text: string): void {
    if (!this.eatOp(text)) fail(this.layer, `expected ${text}, found ${this.describe()}`);
  }
  needEnd(what: string): void {
    if (!this.atEnd()) fail(this.layer, `unexpected ${this.describe()} after ${what}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Functions: layers 1 (shape), 2 (tokenizer), 3 (grammar) and 4 (deny-net).

export interface ScanContext {
  /** Tables created by the migration set. Function bodies and statements may only refer to these. */
  knownTables: ReadonlySet<string>;
  /** Functions defined by the migration set. Triggers may only call these. */
  knownFunctions: ReadonlySet<string>;
}

const FUNCTION_START = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i;
const BLANK_CHUNK = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$/;

/** Layer 1a: cut a function statement into header, body and trailer. Only plain $$ quoting is accepted. */
export function splitFunction(chunk: string): { header: string; body: string; trailer: string } {
  const n = chunk.length;
  let i = 0;
  let open = -1;
  while (i < n) {
    const c = chunk.charAt(i);
    if (c === '-' && chunk.charAt(i + 1) === '-') {
      while (i < n && chunk.charAt(i) !== '\n') i += 1;
      continue;
    }
    if (c === '/' && chunk.charAt(i + 1) === '*') {
      const end = chunk.indexOf('*/', i + 2);
      if (end < 0) fail('shape', 'unterminated comment');
      i = end + 2;
      continue;
    }
    if (c === "'") {
      i += 1;
      while (i < n && !(chunk.charAt(i) === "'" && chunk.charAt(i + 1) !== "'")) i += chunk.charAt(i) === "'" ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === '"') fail('shape', 'double-quoted identifier in the function header');
    if (c === '$') {
      open = i;
      break;
    }
    i += 1;
  }
  if (open < 0) fail('shape', 'no dollar-quoted body (a string-literal body is not accepted)');
  if (chunk.slice(open, open + 2) !== '$$') fail('shape', 'the body must use plain $$ quoting, not a tagged $tag$');
  const close = chunk.indexOf('$$', open + 2);
  if (close < 0) fail('shape', 'the body is not closed by $$');
  return { header: chunk.slice(0, open), body: chunk.slice(open + 2, close), trailer: chunk.slice(close + 2) };
}

/** Layer 1b: the exact header. Returns the function name. */
export function checkFunctionHeader(header: string): string {
  const tokens = lex(header, 'shape');
  const c = new Cursor(tokens, 'shape');
  c.needWord('CREATE');
  if (c.eatWord('OR')) c.needWord('REPLACE');
  c.needWord('FUNCTION');
  const nameToken = c.peek();
  const name = nameToken?.type === 'WORD' ? nameToken.text : '';
  if (!/^bb_[a-z0-9_]+$/.test(name)) fail('shape', `the function name must be lower-case bb_<name> and unqualified, got ${nameToken?.text ?? 'nothing'}`);
  c.pos += 1;
  if (!c.eatPunct('(') || !c.eatPunct(')')) fail('shape', 'the function takes no parameters');
  c.needWord('RETURNS');
  c.needWord('TRIGGER');
  c.needWord('LANGUAGE');
  c.needWord('PLPGSQL');
  c.needWord('AS');
  if (!c.atEnd()) fail('shape', `unexpected ${c.describe()} after AS (attributes such as SECURITY DEFINER, SET, STRICT and COST are not accepted)`);
  return name;
}

const BODY_RESERVED: ReadonlySet<string> = new Set([
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END', 'BEGIN', 'DECLARE', 'RAISE', 'EXCEPTION', 'USING', 'RETURN', 'SELECT', 'INTO', 'FROM', 'JOIN', 'ON', 'WHERE',
  'AND', 'OR', 'NOT', 'IS', 'NULL', 'DISTINCT', 'IN', 'ANY', 'EXISTS', 'TRUE', 'FALSE', 'AS', 'NEW', 'OLD', 'ERRCODE',
]);

/** Layer 3: a positive grammar for the small PL/pgSQL subset the guard functions use. */
export function checkBodyGrammar(tokens: readonly Token[], ctx: ScanContext): void {
  if (tokens.length > MAX_BODY_TOKENS) fail('grammar', `the body has more than ${MAX_BODY_TOKENS} tokens`);
  const c = new Cursor(tokens, 'grammar');
  const declared = new Set<string>();
  let depth = 0;

  const enter = (): void => {
    depth += 1;
    if (depth > MAX_BODY_DEPTH) fail('grammar', 'nesting is too deep');
  };
  const leave = (): void => {
    depth -= 1;
  };
  function ident(): string {
    const t = c.peek();
    if (!t || t.type !== 'WORD' || BODY_RESERVED.has(t.text.toUpperCase())) fail('grammar', `expected a name, found ${c.describe()}`);
    c.pos += 1;
    return t.text.toLowerCase();
  }
  function tableRef(): void {
    const name = ident();
    if (!ctx.knownTables.has(name)) fail('grammar', `table ${name} is not created by these migrations`);
    c.eatWord('AS');
    const alias = c.peek();
    if (alias && alias.type === 'WORD' && !BODY_RESERVED.has(alias.text.toUpperCase())) c.pos += 1;
  }
  function selectTail(): void {
    if (c.eatWord('FROM')) {
      tableRef();
      while (c.upper() === 'JOIN') {
        c.pos += 1;
        tableRef();
        c.needWord('ON');
        expression();
      }
    }
    if (c.eatWord('WHERE')) expression();
  }
  function subselect(): void {
    enter();
    c.needWord('SELECT');
    expression();
    while (c.eatPunct(',')) expression();
    selectTail();
    leave();
  }
  function primary(): void {
    const t = c.peek();
    if (!t) fail('grammar', 'the body ends inside an expression');
    if (t.type === 'NUM' || t.type === 'STR') {
      c.pos += 1;
      return;
    }
    if (t.type === 'PUNCT' && t.text === '(') {
      c.pos += 1;
      enter();
      expression();
      while (c.eatPunct(',')) expression();
      c.needPunct(')');
      leave();
      return;
    }
    if (t.type !== 'WORD') fail('grammar', `unexpected ${t.text} in an expression`);
    const u = t.text.toUpperCase();
    if (u === 'TRUE' || u === 'FALSE' || u === 'NULL') {
      c.pos += 1;
      return;
    }
    if (u === 'EXISTS') {
      c.pos += 1;
      c.needPunct('(');
      subselect();
      c.needPunct(')');
      return;
    }
    if (c.isPunct('(', 1)) {
      const fn = t.text.toLowerCase();
      if (!BODY_FUNCTIONS.has(fn)) fail('grammar', `function ${fn}() is not on the allow-list`);
      c.pos += 2;
      enter();
      if (!c.isPunct(')')) {
        expression();
        while (c.eatPunct(',')) expression();
      }
      c.needPunct(')');
      leave();
      return;
    }
    if (u === 'NEW' || u === 'OLD') {
      c.pos += 1;
      if (c.eatPunct('.')) ident();
      return;
    }
    if (BODY_RESERVED.has(u)) fail('grammar', `unexpected keyword ${t.text} in an expression`);
    c.pos += 1;
    if (c.eatPunct('.')) ident();
  }
  function additive(): void {
    primary();
    for (;;) {
      const t = c.peek();
      if (t?.type === 'OP' && (t.text === '+' || t.text === '-' || t.text === '||')) {
        c.pos += 1;
        primary();
      } else {
        return;
      }
    }
  }
  function comparison(): void {
    additive();
    const t = c.peek();
    if (t?.type === 'OP' && ['=', '<>', '!=', '<', '<=', '>', '>='].includes(t.text)) {
      c.pos += 1;
      if (c.upper() === 'ANY') {
        c.pos += 1;
        c.needPunct('(');
        expression();
        c.needPunct(')');
      } else {
        additive();
      }
      return;
    }
    if (c.upper() === 'IS') {
      c.pos += 1;
      c.eatWord('NOT');
      if (c.eatWord('NULL')) return;
      c.needWord('DISTINCT');
      c.needWord('FROM');
      additive();
      return;
    }
    if (c.upper() === 'NOT' && c.upper(1) === 'IN') c.pos += 1;
    if (c.eatWord('IN')) {
      c.needPunct('(');
      expression();
      while (c.eatPunct(',')) expression();
      c.needPunct(')');
    }
  }
  function negation(): void {
    if (c.eatWord('NOT')) negation();
    else comparison();
  }
  function conjunction(): void {
    negation();
    while (c.eatWord('AND')) negation();
  }
  function expression(): void {
    conjunction();
    while (c.eatWord('OR')) conjunction();
  }
  function statements(stop: readonly string[]): void {
    while (!c.atEnd() && !stop.includes(c.upper())) statement();
  }
  function statement(): void {
    enter();
    const u = c.upper();
    const next = c.peek(1);
    if (u === 'IF') {
      c.pos += 1;
      expression();
      c.needWord('THEN');
      statements(['ELSIF', 'ELSE', 'END']);
      while (c.eatWord('ELSIF')) {
        expression();
        c.needWord('THEN');
        statements(['ELSIF', 'ELSE', 'END']);
      }
      if (c.eatWord('ELSE')) statements(['END']);
      c.needWord('END');
      c.needWord('IF');
      c.needPunct(';');
    } else if (u === 'RAISE') {
      c.pos += 1;
      c.needWord('EXCEPTION');
      if (c.peek()?.type !== 'STR') fail('grammar', 'RAISE EXCEPTION needs a message string');
      c.pos += 1;
      while (c.eatPunct(',')) expression();
      if (c.eatWord('USING')) {
        c.needWord('ERRCODE');
        c.needOp('=');
        const code = c.peek();
        if (code?.type !== 'STR' || !BODY_ERRCODES.has(code.text)) fail('grammar', `ERRCODE must be one of ${[...BODY_ERRCODES].join(', ')}`);
        c.pos += 1;
      }
      c.needPunct(';');
    } else if (u === 'RETURN') {
      c.pos += 1;
      if (!(c.eatWord('NEW') || c.eatWord('OLD') || c.eatWord('NULL'))) fail('grammar', 'RETURN must be NEW, OLD or NULL');
      c.needPunct(';');
    } else if (u === 'SELECT') {
      c.pos += 1;
      expression();
      while (c.eatPunct(',')) expression();
      c.needWord('INTO');
      const variable = ident();
      if (!declared.has(variable)) fail('grammar', `variable ${variable} is not declared`);
      selectTail();
      c.needPunct(';');
    } else if (u === 'NEW' && next?.type === 'PUNCT' && next.text === '.') {
      c.pos += 2;
      ident();
      c.needOp(':=');
      expression();
      c.needPunct(';');
    } else if (c.peek()?.type === 'WORD' && declared.has(c.peek()?.text.toLowerCase() ?? '') && next?.type === 'OP' && next.text === ':=') {
      c.pos += 2;
      expression();
      c.needPunct(';');
    } else {
      fail('grammar', `statement not in the accepted subset: ${c.describe()}`);
    }
    leave();
  }

  if (c.eatWord('DECLARE')) {
    while (c.upper() !== 'BEGIN') {
      const name = ident();
      const type = c.peek();
      if (type?.type !== 'WORD' || !BODY_TYPES.has(type.text.toLowerCase())) fail('grammar', `declared type not accepted: ${c.describe()}`);
      c.pos += 1;
      c.needPunct(';');
      declared.add(name);
    }
  }
  c.needWord('BEGIN');
  statements(['END']);
  c.needWord('END');
  c.needPunct(';');
  c.needEnd('the closing END;');
}

const DENY_WORDS: ReadonlySet<string> = new Set([
  'EXECUTE', 'COPY', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'DROP', 'TRUNCATE', 'DELETE', 'UPDATE', 'INSERT', 'MERGE', 'ALTER', 'GRANT', 'REVOKE',
  'CREATE', 'SET', 'RESET', 'DO', 'CALL', 'LISTEN', 'NOTIFY', 'UNLISTEN', 'LOCK', 'VACUUM', 'ANALYZE', 'REINDEX', 'CLUSTER', 'REFRESH', 'PERFORM', 'LOOP',
  'FOR', 'WHILE', 'FOREACH', 'OPEN', 'FETCH', 'CLOSE', 'MOVE', 'RETURNING', 'WITH', 'UNION', 'INTERSECT', 'ASSERT', 'GET', 'DIAGNOSTICS', 'QUERY', 'NEXT',
  'PROGRAM', 'SECURITY', 'DEFINER', 'EXIT', 'CONTINUE', 'WHEN', 'OTHERS', 'CASE',
]);
const DENY_FUNCTION_NAMES = /^(pg_|dblink|lo_|nextval|setval|set_config|current_setting|txid_|random|clock_timestamp|version|format|query_to_xml)/i;

/** Layer 4: an independent scan over the same tokens. A dangerous body must be refused by this layer and by the grammar. */
export function checkBodyDenyNet(tokens: readonly Token[]): void {
  tokens.forEach((t, i) => {
    if (t.type !== 'WORD') return;
    const u = t.text.toUpperCase();
    if (DENY_WORDS.has(u)) fail('deny-net', `forbidden word ${t.text}`);
    if (DENY_FUNCTION_NAMES.test(t.text)) fail('deny-net', `forbidden function name ${t.text}`);
    const next = tokens[i + 1];
    // A structural keyword followed by "(" (IF (, AND (, NOT (, ...) is not a call. Any other name followed by "(" is.
    if (next?.type === 'PUNCT' && next.text === '(' && !BODY_FUNCTIONS.has(t.text.toLowerCase()) && !BODY_RESERVED.has(u)) {
      fail('deny-net', `call to ${t.text}() is not on the allow-list`);
    }
    if (next?.type === 'OP' && next.text === '::') fail('deny-net', 'cast');
  });
}

/** Validates one function statement through all four layers and returns its name. */
export function validateFunctionChunk(chunk: string, ctx: ScanContext): string {
  const { header, body, trailer } = splitFunction(chunk);
  const name = checkFunctionHeader(header);
  const trailing = lex(trailer, 'shape');
  const onlySemicolon = trailing.length === 1 && trailing[0]?.text === ';';
  if (trailing.length !== 0 && !onlySemicolon) fail('shape', `unexpected text after the closing $$: ${trailing.map((t) => t.text).join(' ')}`);
  if (body.length > MAX_BODY_CHARS) fail('shape', `the function body is longer than ${MAX_BODY_CHARS} characters`);
  const tokens = lex(body, 'tokenizer');
  checkBodyDenyNet(tokens);
  checkBodyGrammar(tokens, ctx);
  return name;
}

// ---------------------------------------------------------------------------------------------------------------------
// Statements outside functions.

export type StatementKind =
  | 'CREATE EXTENSION'
  | 'CREATE TYPE'
  | 'CREATE TABLE'
  | 'ALTER TABLE ADD CONSTRAINT'
  | 'CREATE INDEX'
  | 'CREATE FUNCTION'
  | 'CREATE TRIGGER'
  | 'CREATE VIEW'
  | 'INSERT request_transitions';

export interface Classified {
  kind: StatementKind;
  /** The created object: extension, type, table, function, trigger or view name. */
  name?: string;
  /** For ALTER TABLE ADD CONSTRAINT: FOREIGN KEY, UNIQUE, PRIMARY KEY, CHECK or EXCLUDE. */
  constraint?: string;
  /** For INSERT: the number of rows. */
  rows?: number;
}

export function splitStatements(sql: string): string[] {
  return sql.split(STATEMENT_BREAKPOINT).filter((chunk) => !BLANK_CHUNK.test(chunk));
}

/** Names of the tables and functions the migration set creates, found without judging the statements. */
export function collectDefinitions(chunks: readonly string[]): ScanContext {
  const knownTables = new Set<string>();
  const knownFunctions = new Set<string>();
  for (const chunk of chunks) {
    if (FUNCTION_START.test(chunk)) {
      const found = /FUNCTION\s+([a-z0-9_]+)\s*\(/i.exec(chunk);
      if (found?.[1]) knownFunctions.add(found[1].toLowerCase());
      continue;
    }
    try {
      const tokens = lex(chunk, 'statement', { ddl: true });
      const [first, second, third] = tokens;
      if (first?.text.toUpperCase() === 'CREATE' && second?.text.toUpperCase() === 'TABLE' && third?.type === 'QIDENT') knownTables.add(third.text.toLowerCase());
    } catch {
      // The statement scan reports it. It just contributes no name.
    }
  }
  return { knownTables, knownFunctions };
}

function matchingParen(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t?.type !== 'PUNCT') continue;
    if (t.text === '(') depth += 1;
    if (t.text === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return fail('statement', 'unbalanced parentheses');
}

function isGeographyPoint(tokens: readonly Token[], i: number): boolean {
  const [, open, point, comma, srid, close] = tokens.slice(i, i + 6);
  return open?.text === '(' && point?.text === 'Point' && comma?.text === ',' && srid?.text === '4326' && close?.text === ')';
}

/** The embedded-expression gate: a call may only be to a function on the allow-list, or be SQL syntax. */
function checkEmbeddedCalls(tokens: readonly Token[], allowReferences: boolean): void {
  tokens.forEach((t, i) => {
    if (t.type === 'WORD' && t.text.toUpperCase() === 'SELECT') fail('statement', 'a sub-select is not accepted here');
    const next = tokens[i + 1];
    if (next?.type !== 'PUNCT' || next.text !== '(') return;
    if (t.type === 'WORD') {
      const lower = t.text.toLowerCase();
      if (lower === 'geography' && isGeographyPoint(tokens, i)) return;
      if (INDEX_METHODS.has(lower) && tokens[i - 1]?.text.toUpperCase() === 'USING') return;
      if (DDL_SYNTAX.has(t.text.toUpperCase())) return;
      if (!DDL_FUNCTIONS.has(lower)) fail('statement', `call to ${t.text}() is not accepted`);
    } else if (t.type === 'QIDENT') {
      const reference =
        allowReferences && tokens[i - 1]?.text === '.' && tokens[i - 2]?.type === 'QIDENT' && tokens[i - 3]?.text.toUpperCase() === 'REFERENCES';
      if (!reference) fail('statement', 'a quoted name followed by ( would be a call');
    }
  });
}

function nameOf(c: Cursor, what: string): string {
  const t = c.peek();
  if (!t || (t.type !== 'WORD' && t.type !== 'QIDENT') || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.text)) fail('statement', `expected ${what}, found ${c.describe()}`);
  c.pos += 1;
  return t.text;
}

function knownTable(ctx: ScanContext, name: string): void {
  if (!ctx.knownTables.has(name.toLowerCase())) fail('statement', `table ${name} is not created by these migrations`);
}

function gateExtension(c: Cursor): Classified {
  c.needWord('EXTENSION');
  c.needWord('IF');
  c.needWord('NOT');
  c.needWord('EXISTS');
  const t = c.peek();
  const name = t?.type === 'WORD' ? t.text.toLowerCase() : '';
  if (!EXTENSIONS.has(name)) fail('statement', `extension ${t?.text ?? 'nothing'} is not accepted (allowed: ${[...EXTENSIONS].join(', ')})`);
  c.pos += 1;
  c.needEnd('the extension name');
  return { kind: 'CREATE EXTENSION', name };
}

function gateType(c: Cursor): Classified {
  c.needWord('TYPE');
  const schema = c.peek();
  if (schema?.type !== 'QIDENT' || schema.text !== 'public') fail('statement', 'the type must be "public"."<name>"');
  c.pos += 1;
  c.needPunct('.');
  const name = c.peek();
  if (name?.type !== 'QIDENT' || !/^[a-z_]+$/.test(name.text)) fail('statement', 'the type name must be a quoted lower-case name');
  c.pos += 1;
  c.needWord('AS');
  c.needWord('ENUM');
  c.needPunct('(');
  do {
    if (c.peek()?.type !== 'STR') fail('statement', `an enum value must be a string, found ${c.describe()}`);
    c.pos += 1;
  } while (c.eatPunct(','));
  c.needPunct(')');
  c.needEnd('the enum values');
  return { kind: 'CREATE TYPE', name: name.text };
}

function gateTable(c: Cursor, tokens: readonly Token[]): Classified {
  c.needWord('TABLE');
  const name = c.peek();
  if (name?.type !== 'QIDENT' || !/^[a-z_]+$/.test(name.text)) fail('statement', 'the table name must be a quoted lower-case name');
  c.pos += 1;
  if (!c.isPunct('(')) fail('statement', `expected "(", found ${c.describe()}`);
  const close = matchingParen(tokens, c.pos);
  if (close !== tokens.length - 1) fail('statement', 'nothing may follow the column list (no INHERITS, PARTITION BY, WITH, TABLESPACE or AS)');
  const body = tokens.slice(c.pos + 1, close);
  if (body.some((t) => t.type === 'WORD' && t.text.toUpperCase() === 'INHERITS')) fail('statement', 'INHERITS is not accepted');
  checkEmbeddedCalls(body, true);
  c.pos = tokens.length;
  return { kind: 'CREATE TABLE', name: name.text };
}

function gateAlter(c: Cursor, tokens: readonly Token[], ctx: ScanContext): Classified {
  c.needWord('TABLE');
  const table = nameOf(c, 'a table name');
  knownTable(ctx, table);
  c.needWord('ADD');
  c.needWord('CONSTRAINT');
  nameOf(c, 'a constraint name');
  let constraint = c.upper();
  if (constraint === 'FOREIGN' || constraint === 'PRIMARY') {
    c.pos += 1;
    c.needWord('KEY');
    constraint = constraint === 'FOREIGN' ? 'FOREIGN KEY' : 'PRIMARY KEY';
  } else if (['UNIQUE', 'CHECK', 'EXCLUDE'].includes(constraint)) {
    c.pos += 1;
  } else {
    fail('statement', `only ADD CONSTRAINT with FOREIGN KEY, UNIQUE, PRIMARY KEY, CHECK or EXCLUDE is accepted, found ${c.describe()}`);
  }
  const rest = tokens.slice(c.pos);
  if (constraint === 'FOREIGN KEY') {
    const at = rest.findIndex((t) => t.type === 'WORD' && t.text.toUpperCase() === 'REFERENCES');
    const [schema, dot, target, open] = rest.slice(at + 1, at + 5);
    if (at < 0 || schema?.type !== 'QIDENT' || schema.text !== 'public' || dot?.text !== '.' || target?.type !== 'QIDENT' || open?.text !== '(') {
      fail('statement', 'a foreign key must end in REFERENCES "public"."<table>"(<columns>)');
    }
    knownTable(ctx, target.text);
  }
  matchingParen(rest, Math.max(0, rest.findIndex((t) => t.type === 'PUNCT' && t.text === '(')));
  checkEmbeddedCalls(rest, constraint === 'FOREIGN KEY');
  c.pos = tokens.length;
  return { kind: 'ALTER TABLE ADD CONSTRAINT', name: table, constraint };
}

function gateIndex(c: Cursor, tokens: readonly Token[], ctx: ScanContext): Classified {
  c.eatWord('UNIQUE');
  c.needWord('INDEX');
  const name = c.peek();
  if (name?.type !== 'QIDENT') fail('statement', 'the index name must be quoted');
  c.pos += 1;
  c.needWord('ON');
  const table = c.peek();
  if (table?.type !== 'QIDENT') fail('statement', 'the table name must be quoted');
  c.pos += 1;
  knownTable(ctx, table.text);
  if (c.eatWord('USING')) {
    const method = c.peek();
    if (method?.type !== 'WORD' || !INDEX_METHODS.has(method.text.toLowerCase())) fail('statement', `index method must be one of ${[...INDEX_METHODS].join(', ')}`);
    c.pos += 1;
  }
  if (!c.isPunct('(')) fail('statement', `expected "(", found ${c.describe()}`);
  const close = matchingParen(tokens, c.pos);
  const after = tokens.slice(close + 1);
  if (after.length > 0 && after[0]?.text.toUpperCase() !== 'WHERE') fail('statement', `only an optional WHERE may follow the column list, found ${after[0]?.text ?? ''}`);
  checkEmbeddedCalls(tokens.slice(c.pos), false);
  c.pos = tokens.length;
  return { kind: 'CREATE INDEX', name: name.text };
}

function gateTrigger(c: Cursor, ctx: ScanContext): Classified {
  c.needWord('TRIGGER');
  const name = nameOf(c, 'a trigger name');
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) fail('statement', 'the trigger name must be lower-case');
  c.needWord('BEFORE');
  const events = ['INSERT', 'UPDATE', 'DELETE'];
  do {
    if (!events.includes(c.upper())) fail('statement', `expected INSERT, UPDATE or DELETE, found ${c.describe()}`);
    c.pos += 1;
  } while (c.eatWord('OR'));
  c.needWord('ON');
  knownTable(ctx, nameOf(c, 'a table name'));
  c.needWord('FOR');
  c.needWord('EACH');
  c.needWord('ROW');
  c.needWord('EXECUTE');
  c.needWord('FUNCTION');
  const fn = nameOf(c, 'a function name').toLowerCase();
  if (!ctx.knownFunctions.has(fn)) fail('statement', `trigger function ${fn} is not defined by these migrations`);
  c.needPunct('(');
  c.needPunct(')');
  c.needEnd('the trigger function call');
  return { kind: 'CREATE TRIGGER', name };
}

function gateView(c: Cursor, ctx: ScanContext): Classified {
  c.needWord('VIEW');
  const name = nameOf(c, 'a view name');
  c.needWord('AS');
  c.needWord('SELECT');
  do {
    nameOf(c, 'a column name');
  } while (c.eatPunct(','));
  c.needWord('FROM');
  knownTable(ctx, nameOf(c, 'a table name'));
  c.needEnd('the view definition');
  return { kind: 'CREATE VIEW', name };
}

function gateInsert(c: Cursor): Classified {
  c.needWord('INTO');
  c.needWord('REQUEST_TRANSITIONS');
  c.needPunct('(');
  c.needWord('FROM_STATUS');
  c.needPunct(',');
  c.needWord('TO_STATUS');
  c.needPunct(',');
  c.needWord('ALLOWED_ACTORS');
  c.needPunct(')');
  c.needWord('VALUES');
  const code = (): void => {
    const t = c.peek();
    if (t?.type !== 'STR' || !/^[A-Z_]+$/.test(t.text)) fail('statement', `expected an upper-case code string, found ${c.describe()}`);
    c.pos += 1;
  };
  let rows = 0;
  do {
    c.needPunct('(');
    code();
    c.needPunct(',');
    code();
    c.needPunct(',');
    c.needWord('ARRAY');
    c.needPunct('[');
    do code();
    while (c.eatPunct(','));
    c.needPunct(']');
    c.needOp('::');
    c.needWord('REQUEST_ACTOR_KIND');
    c.needPunct('[');
    c.needPunct(']');
    c.needPunct(')');
    rows += 1;
  } while (c.eatPunct(','));
  c.needEnd('the VALUES rows');
  return { kind: 'INSERT request_transitions', rows };
}

/** Classifies one statement and refuses anything that is not an accepted shape. */
export function classifyStatement(chunk: string, ctx: ScanContext): Classified {
  if (FUNCTION_START.test(chunk)) return { kind: 'CREATE FUNCTION', name: validateFunctionChunk(chunk, ctx) };
  const all = lex(chunk, 'statement', { ddl: true });
  if (all.length === 0) fail('chunk', 'empty statement');
  const semicolons = all.flatMap((t, i) => (t.type === 'PUNCT' && t.text === ';' ? [i] : []));
  if (semicolons.length > 1 || (semicolons.length === 1 && semicolons[0] !== all.length - 1)) fail('chunk', 'more than one statement in one chunk');
  const tokens = semicolons.length === 1 ? all.slice(0, -1) : all;
  const c = new Cursor(tokens, 'statement');
  const verb = c.upper();
  if (verb === 'INSERT') {
    c.pos += 1;
    return gateInsert(c);
  }
  if (verb === 'ALTER') {
    c.pos += 1;
    return gateAlter(c, tokens, ctx);
  }
  if (verb !== 'CREATE') fail('statement', `a statement may not start with ${c.describe()}`);
  c.pos += 1;
  switch (c.upper()) {
    case 'EXTENSION':
      return gateExtension(c);
    case 'TYPE':
      return gateType(c);
    case 'TABLE':
      return gateTable(c, tokens);
    case 'UNIQUE':
    case 'INDEX':
      return gateIndex(c, tokens, ctx);
    case 'TRIGGER':
      return gateTrigger(c, ctx);
    case 'VIEW':
      return gateView(c, ctx);
    default:
      return fail('statement', `CREATE ${c.describe()} is not accepted`);
  }
}

export interface MigrationStatements {
  tag: string;
  statements: readonly string[];
}

export interface ValidatedMigration {
  tag: string;
  classified: readonly Classified[];
}

/** Scans every statement of every migration. Returns all the problems it finds, so one run reports them all. */
export function validateMigrationSet(migrations: readonly MigrationStatements[]): { migrations: ValidatedMigration[]; problems: string[] } {
  const ctx = collectDefinitions(migrations.flatMap((m) => m.statements));
  const problems: string[] = [];
  const validated: ValidatedMigration[] = [];
  for (const migration of migrations) {
    const classified: Classified[] = [];
    migration.statements.forEach((statement, index) => {
      try {
        classified.push(classifyStatement(statement, ctx));
      } catch (error) {
        if (!(error instanceof ScanError)) throw error;
        problems.push(`${migration.tag}, statement ${index + 1}: [${error.layer}] ${error.message}`);
      }
    });
    validated.push({ tag: migration.tag, classified });
  }
  return { migrations: validated, problems };
}
