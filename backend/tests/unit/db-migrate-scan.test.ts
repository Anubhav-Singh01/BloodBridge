import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ScanError,
  checkBodyDenyNet,
  checkBodyGrammar,
  classifyStatement,
  collectDefinitions,
  lex,
  splitFunction,
  splitStatements,
  validateFunctionChunk,
  validateMigrationSet,
  type ScanContext,
  type ScanLayer,
} from '../../scripts/db-migrate-scan.js';

// Characters that are hard to see, built from their code points so the source stays plain ASCII.
const NBSP = String.fromCharCode(0xa0); // a no-break space: looks like a space
const E_ACUTE = String.fromCharCode(0xe9);
const GREEK_QUESTION_MARK = String.fromCharCode(0x37e); // looks exactly like a semicolon

const migrationsDir = join(import.meta.dirname, '../../drizzle');
const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
const realMigrations = journal.entries.map((e) => ({ tag: e.tag, statements: splitStatements(readFileSync(join(migrationsDir, `${e.tag}.sql`), 'utf8')) }));
const realContext: ScanContext = collectDefinitions(realMigrations.flatMap((m) => m.statements));
const realFunctionChunks = realMigrations.flatMap((m) => m.statements.filter((s) => /CREATE (OR REPLACE )?FUNCTION/.test(s)));

/** Runs a scan and returns the layer that refused it, or null when it was accepted. */
function refusedBy(scan: () => unknown): ScanLayer | null {
  try {
    scan();
    return null;
  } catch (error) {
    if (error instanceof ScanError) return error.layer;
    throw error;
  }
}

const wrap = (inner: string, declare = ''): string =>
  `CREATE OR REPLACE FUNCTION bb_probe() RETURNS trigger LANGUAGE plpgsql AS $$\n${declare}BEGIN\n  ${inner}\n  RETURN NEW;\nEND;\n$$;`;
const DECLARE_VAR = 'DECLARE\n  referenced boolean;\n';
const fnRefusedBy = (chunk: string): ScanLayer | null => refusedBy(() => validateFunctionChunk(chunk, realContext));

describe('the scanner accepts the real migrations 0000 to 0006', () => {
  it('accepts all 308 statements with no problem, in exactly the expected kinds', () => {
    const result = validateMigrationSet(realMigrations);
    expect(result.problems).toEqual([]);
    const kinds: Record<string, number> = {};
    for (const m of result.migrations) for (const c of m.classified) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
    expect(realMigrations.reduce((n, m) => n + m.statements.length, 0)).toBe(308);
    expect(kinds).toEqual({
      'CREATE EXTENSION': 2,
      'CREATE TYPE': 36,
      'CREATE TABLE': 41,
      'ALTER TABLE ADD CONSTRAINT': 80,
      'CREATE INDEX': 75,
      'CREATE FUNCTION': 15,
      'CREATE TRIGGER': 57,
      'INSERT request_transitions': 1,
      'CREATE VIEW': 1,
    });
  });

  it('validates each of the 15 functions and returns their names', () => {
    expect(realFunctionChunks).toHaveLength(15);
    const names = realFunctionChunks.map((c) => validateFunctionChunk(c, realContext));
    expect(names).toContain('bb_touch_updated_at');
    expect(names).toContain('bb_notification_batch_guard');
    expect(new Set(names).size).toBe(15);
  });
});

describe('function statements: the header must have exactly the accepted shape', () => {
  const H = (mid: string, tail = '$$;'): string => `CREATE OR REPLACE FUNCTION ${mid}\nBEGIN\n  RETURN NEW;\nEND;\n${tail}`;
  const good = 'bb_probe() RETURNS trigger LANGUAGE plpgsql AS $$';
  const attacks: Record<string, string[]> = {
    'SECURITY DEFINER': [H('bb_probe() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$')],
    'a SET clause': [H('bb_probe() RETURNS trigger LANGUAGE plpgsql SET search_path = evil AS $$')],
    'other languages': ['sql', 'plpython3u', 'c', 'plperl'].map((l) => H(`bb_probe() RETURNS trigger LANGUAGE ${l} AS $$`)),
    parameters: [H('bb_probe(x int) RETURNS trigger LANGUAGE plpgsql AS $$')],
    'other return types': ['int', 'void', 'SETOF int'].map((r) => H(`bb_probe() RETURNS ${r} LANGUAGE plpgsql AS $$`)),
    'qualified or non-bb names': ['public.bb_probe()', 'pg_catalog.now()', 'now()', 'evil()', 'BB_probe()', '"bb_probe"()'].map((n) => H(`${n} RETURNS trigger LANGUAGE plpgsql AS $$`)),
    attributes: ['STRICT', 'VOLATILE', 'IMMUTABLE', 'COST 1', 'PARALLEL SAFE'].map((a) => H(`bb_probe() RETURNS trigger LANGUAGE plpgsql ${a} AS $$`)),
    'body forms': [
      "CREATE OR REPLACE FUNCTION bb_probe() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END;'",
      H('bb_probe() RETURNS trigger LANGUAGE plpgsql AS $body$', '$body$;'),
      H('bb_probe() RETURNS trigger LANGUAGE plpgsql AS $$', '$$;$$'),
      // Anything between AS and the $$ body: the C-language form, or a stray word.
      H("bb_probe() RETURNS trigger LANGUAGE plpgsql AS 'obj_file', 'link_symbol' $$"),
      H('bb_probe() RETURNS trigger LANGUAGE plpgsql AS foo $$'),
    ],
    'text after the body': [H(good, '$$; DROP TABLE users;'), H(good, '$$ LANGUAGE sql;'), H(good, '$$ SECURITY DEFINER;'), H(good, '$$;\nSELECT 1;')],
    'other object kinds': [
      'CREATE OR REPLACE PROCEDURE bb_probe() LANGUAGE plpgsql AS $$ BEGIN NULL; END; $$;',
      'CREATE AGGREGATE bb_probe(int) (SFUNC = int4pl, STYPE = int);',
      'CREATE OPERATOR === (FUNCTION = bb_probe);',
    ],
    'body structure': [
      'CREATE OR REPLACE FUNCTION bb_probe() RETURNS trigger LANGUAGE plpgsql AS $$$$;',
      'CREATE OR REPLACE FUNCTION bb_probe() RETURNS trigger LANGUAGE plpgsql AS $$ RETURN NEW; $$;',
      'CREATE OR REPLACE FUNCTION bb_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; DROP TABLE users; $$;',
      'CREATE OR REPLACE FUNCTION bb_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$ AS $$ BEGIN NULL; END; $$;',
    ],
    encoding: [
      'CREATE OR REPLACE FUNCTION bb_probe() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN NEW;\u0000\nEND;\n$$;',
      "CREATE OR REPLACE FUNCTION bb_probe() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  RAISE EXCEPTION 'x' USING ERRCODE = 'check_violation';" + NBSP + "RETURN NEW;\nEND;\n$$;",
    ],
  };

  it('accepts the plain form, so the attacks below are refused for the right reason', () => {
    expect(fnRefusedBy(H(good))).toBeNull();
    expect(fnRefusedBy(H(good).replace('CREATE OR REPLACE', 'CREATE'))).toBeNull();
  });

  for (const [family, chunks] of Object.entries(attacks)) {
    it(`refuses ${family}`, () => {
      for (const chunk of chunks) expect({ family, chunk: chunk.slice(0, 90), layer: fnRefusedBy(chunk) }).not.toEqual({ family, chunk: chunk.slice(0, 90), layer: null });
    });
  }
  it('is a total of at least 37 refused header and shape attacks', () => {
    expect(Object.values(attacks).flat().length).toBeGreaterThanOrEqual(37);
  });
});

describe('function bodies: a harmless-looking function whose body attempts each dangerous operation', () => {
  // Families that are dangerous operations. Each of these must be refused by the grammar alone and by the deny-net alone.
  const dangerous: Record<string, string[]> = {
    'dynamic EXECUTE': ["EXECUTE 'DROP TABLE users';", "EXECUTE format('DROP TABLE %I', 'users');", "EXECUTE 'select 1' INTO referenced;", "eXeCuTe 'x';", "IF NEW.status = 'X' THEN EXECUTE 'DELETE FROM users'; END IF;"],
    COPY: ["COPY users TO PROGRAM 'id';", "COPY users FROM '/etc/passwd';"],
    'transaction control': ['COMMIT;', 'ROLLBACK;', 'SAVEPOINT s;', 'RELEASE SAVEPOINT s;', 'ROLLBACK TO SAVEPOINT s;'],
    DROP: ['DROP TABLE users;', 'DROP SCHEMA public CASCADE;', 'DROP FUNCTION bb_touch_updated_at();', 'DROP TRIGGER t ON users;', 'DROP EXTENSION postgis;'],
    TRUNCATE: ['TRUNCATE users;', 'TRUNCATE users, patients CASCADE;'],
    DELETE: ['DELETE FROM users;', 'DELETE FROM users WHERE id = NEW.id;', 'DELETE FROM users RETURNING *;'],
    UPDATE: ["UPDATE users SET status = 'X';", 'UPDATE request_transitions SET allowed_actors = NULL;'],
    INSERT: ['INSERT INTO users (id) VALUES (NEW.id);', "INSERT INTO request_transitions (from_status) VALUES ('A');", 'INSERT INTO audit_logs SELECT * FROM audit_logs;', 'MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE;'],
    ALTER: ['ALTER TABLE users DROP COLUMN status;', 'ALTER ROLE app SUPERUSER;', 'ALTER SYSTEM SET fsync = off;', 'ALTER TABLE users DISABLE TRIGGER ALL;'],
    'GRANT and REVOKE': ['GRANT ALL ON users TO PUBLIC;', 'REVOKE ALL ON users FROM app;', 'GRANT neon_superuser TO PUBLIC;'],
    CREATE: [
      'CREATE EXTENSION dblink;',
      'CREATE TABLE x (id int);',
      'CREATE ROLE evil SUPERUSER;',
      'CREATE FUNCTION bb_evil() RETURNS int LANGUAGE sql AS $x$ select 1 $x$;',
      'CREATE TRIGGER t BEFORE INSERT ON users EXECUTE FUNCTION bb_probe();',
    ],
    'session and configuration': ['SET search_path = evil;', 'SET LOCAL statement_timeout = 0;', 'RESET ALL;', "PERFORM set_config('search_path', 'evil', false);"],
    'other commands': ['DO $x$ BEGIN NULL; END $x$;', 'CALL some_proc();', 'LISTEN chan;', "NOTIFY chan, 'x';", 'LOCK TABLE users;', 'VACUUM users;', 'ANALYZE users;', 'REFRESH MATERIALIZED VIEW v;', 'CLUSTER users;', 'REINDEX TABLE users;'],
    'side-effect functions': [
      'PERFORM pg_terminate_backend(1);',
      'PERFORM pg_sleep(60);',
      "PERFORM nextval('s');",
      "PERFORM lo_import('/etc/passwd');",
      "PERFORM dblink_exec('host=x', 'drop table y');",
      "PERFORM pg_read_file('/etc/passwd');",
      'PERFORM pg_advisory_lock(1);',
      'referenced := pg_backend_pid();',
      "SELECT nextval('s') INTO referenced;",
      'SELECT lo_unlink(1) INTO referenced;',
      'SELECT version() INTO referenced;',
      "SELECT current_setting('x') INTO referenced;",
      'SELECT random() INTO referenced;',
      'SELECT (SELECT lo_unlink(1)) INTO referenced;',
      'IF pg_backend_pid() = 1 THEN NULL; END IF;',
      'IF random() > 0.5 THEN RETURN NEW; END IF;',
    ],
    'sub-selects that write': ['IF EXISTS (DELETE FROM users RETURNING 1) THEN NULL; END IF;', 'IF EXISTS (SELECT 1 FROM users FOR UPDATE) THEN NULL; END IF;', 'IF EXISTS (WITH d AS (DELETE FROM users RETURNING 1) SELECT 1 FROM d) THEN NULL; END IF;'],
  };
  // Families that are outside the accepted subset. The grammar always refuses them, the deny-net most of the time.
  const outsideSubset: Record<string, string[]> = {
    'reading outside the migrated tables': ['SELECT 1 INTO referenced FROM pg_shadow;', 'SELECT 1 INTO referenced FROM pg_catalog.pg_authid;', 'SELECT 1 INTO referenced FROM generate_series(1, 10);', 'SELECT 1 INTO referenced FROM information_schema.tables;'],
    'SELECT variants': ['SELECT 1 INTO referenced FROM users FOR UPDATE;', 'SELECT 1 INTO referenced FROM users UNION SELECT 2;', 'WITH d AS (DELETE FROM users RETURNING 1) SELECT 1 INTO referenced FROM d;', 'SELECT 1 INTO referenced FROM users LIMIT 1;', 'SELECT 1 INTO referenced FROM users ORDER BY 1;', 'SELECT 1 INTO referenced FROM users GROUP BY id;', 'SELECT 1 INTO undeclared FROM users;'],
    'PL/pgSQL constructs outside the subset': [
      'LOOP EXIT; END LOOP;', 'FOR r IN SELECT 1 LOOP NULL; END LOOP;', 'WHILE true LOOP NULL; END LOOP;', 'BEGIN NULL; EXCEPTION WHEN OTHERS THEN NULL; END;', '<<lbl>> BEGIN NULL; END;',
      'RETURN QUERY SELECT 1;', 'RETURN NEXT;', 'ASSERT false;', 'GET DIAGNOSTICS referenced = ROW_COUNT;', 'OPEN c FOR SELECT 1;', 'NULL;', "RAISE NOTICE 'x';",
      "RAISE EXCEPTION 'x' USING ERRCODE = 'evil_code';", "RAISE EXCEPTION 'x' USING DETAIL = 'y';", "RAISE EXCEPTION 'x' USING ERRCODE = 'check_violation', DETAIL = (SELECT 1);", 'CASE WHEN true THEN NULL END CASE;',
    ],
    'quoting and encoding tricks': [
      "RAISE EXCEPTION E'x\\'; DROP TABLE users; --';", 'RAISE EXCEPTION $q$x$q$;', '"execute" := 1;', "referenced := 'users'::regclass;", "referenced := CAST('users' AS regclass);", 'DR/**/OP TABLE users;',
      "EXEC/**/UTE 'x';", '-- harmless comment\nDROP TABLE users;', '/* comment */ DROP TABLE users;', "RAISE EXCEPTION U&'x';", "RAISE EXCEPTION 'caf" + E_ACUTE + "';", 'NEW.x := 1' + GREEK_QUESTION_MARK + ' DROP TABLE users;',
    ],
    'assignments outside NEW and declared variables': ['pg_temp.x := 1;', 'users.status := 1;', 'OLD.status := 1;', 'undeclared := 1;'],
  };

  it('accepts the plain function, so the attacks are refused for the right reason', () => {
    expect(fnRefusedBy(wrap("IF NEW.status = 'X' THEN RAISE EXCEPTION 'no' USING ERRCODE = 'integrity_constraint_violation'; END IF;"))).toBeNull();
  });

  for (const [family, list] of Object.entries({ ...dangerous, ...outsideSubset })) {
    it(`refuses every attempt in: ${family} (${list.length})`, () => {
      for (const inner of list) expect({ family, inner, layer: fnRefusedBy(wrap(inner, DECLARE_VAR)) }).not.toEqual({ family, inner, layer: null });
    });
  }

  it('is a total of at least 116 refused body attacks', () => {
    expect(Object.values({ ...dangerous, ...outsideSubset }).flat().length).toBeGreaterThanOrEqual(116);
  });

  // The two layers are independent for every dangerous operation: either one alone refuses it, so neither is the only defence.
  const bodyOf = (inner: string): string => splitFunction(wrap(inner, DECLARE_VAR)).body;
  const stoppedBy = (layer: 'grammar' | 'deny-net', body: string): boolean => {
    try {
      const tokens = lex(body, 'tokenizer');
      if (layer === 'deny-net') checkBodyDenyNet(tokens);
      else checkBodyGrammar(tokens, realContext);
      return false;
    } catch (error) {
      if (error instanceof ScanError) return true; // the tokenizer, which both layers rely on, stopped it
      throw error;
    }
  };
  for (const [family, list] of Object.entries(dangerous)) {
    it(`grammar alone and deny-net alone each refuse: ${family}`, () => {
      for (const inner of list) {
        expect({ family, inner, grammar: stoppedBy('grammar', bodyOf(inner)), denyNet: stoppedBy('deny-net', bodyOf(inner)) }).toEqual({ family, inner, grammar: true, denyNet: true });
      }
    });
  }
});

describe('both layers really run in the pipeline, not only when called one by one', () => {
  it('refuses, by the deny-net, a body that the grammar alone would accept (a column that is named like a forbidden word)', () => {
    const chunk = wrap('NEW.copy := 1;');
    const tokens = lex(splitFunction(chunk).body, 'tokenizer');
    expect(refusedBy(() => checkBodyGrammar(tokens, realContext))).toBeNull();
    expect(fnRefusedBy(chunk)).toBe('deny-net');
  });
  it('refuses, by the grammar, a body that the deny-net alone would accept (a harmless statement outside the subset)', () => {
    const chunk = wrap('NULL;');
    const tokens = lex(splitFunction(chunk).body, 'tokenizer');
    expect(refusedBy(() => checkBodyDenyNet(tokens))).toBeNull();
    expect(fnRefusedBy(chunk)).toBe('grammar');
  });
});

describe('function bodies: inserting a dangerous statement into every real function is always refused', () => {
  const dangerousStatements = [
    "EXECUTE 'DROP TABLE users';", "COPY users TO PROGRAM 'id';", 'COMMIT;', 'DROP TABLE users;', 'TRUNCATE users;', 'DELETE FROM users;', "UPDATE users SET status = 'X';",
    'INSERT INTO users (id) VALUES (1);', 'ALTER TABLE users DROP COLUMN status;', 'GRANT ALL ON users TO PUBLIC;', 'CREATE EXTENSION dblink;', 'SET search_path = evil;',
    'PERFORM pg_sleep(60);', "PERFORM nextval('s');", 'CALL p();',
  ];
  it('refuses each real function body x 15 dangerous statements x every insertion point', () => {
    let attempts = 0;
    let accepted = 0;
    for (const chunk of realFunctionChunks) {
      const { body } = splitFunction(chunk);
      const name = /FUNCTION\s+(\w+)/.exec(chunk)?.[1] ?? 'bb_x';
      const points = new Set<number>([body.search(/BEGIN/) + 5, body.lastIndexOf('END;')]);
      const lastReturn = body.lastIndexOf('RETURN');
      if (lastReturn >= 0) points.add(lastReturn);
      const then = body.search(/THEN/);
      if (then >= 0) points.add(then + 4);
      for (const statement of dangerousStatements) {
        for (const at of points) {
          attempts += 1;
          const mutated = `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$${body.slice(0, at)}\n  ${statement}\n${body.slice(at)}$$;`;
          if (fnRefusedBy(mutated) === null) accepted += 1;
        }
      }
    }
    expect(attempts).toBeGreaterThanOrEqual(15 * 15 * 3);
    expect(accepted).toBe(0);
  });
});

describe('the tokenizer', () => {
  const layerOf = (src: string, ddl = false): ScanLayer | null => refusedBy(() => lex(src, 'tokenizer', { ddl }));
  it('refuses NUL, non-ASCII (also inside a string), dollar signs, prefixed strings and unterminated input', () => {
    for (const bad of ['a\u0000b', 'caf' + E_ACUTE, "'caf" + E_ACUTE + "'", 'x $1', 'x $$ y', "E'x'", "U&'x'", "N'x'", "B'1'", "X'1'", "'unterminated", '/* unterminated', '"quoted"']) {
      expect({ bad, layer: layerOf(bad) }).not.toEqual({ bad, layer: null });
    }
  });
  it('drops line, block and nested block comments, and keeps doubled quotes inside a string', () => {
    expect(lex("a -- b\n c /* d /* e */ f */ g 'it''s'", 'tokenizer').map((t) => t.text)).toEqual(['a', 'c', 'g', "it's"]);
  });
  it('accepts quoted identifiers, brackets and operator runs only in statement mode', () => {
    expect(layerOf('"a"."b"', true)).toBeNull();
    expect(layerOf('a[1] && b ~ c', true)).toBeNull();
    expect(layerOf('a[1]')).not.toBeNull();
    expect(layerOf('a && b')).not.toBeNull();
  });
});

describe('resource limits and the table rule', () => {
  const nested = (n: number): string => wrap('IF true THEN '.repeat(n) + 'RETURN NEW;' + ' END IF;'.repeat(n));
  const repeated = (n: number): string => wrap('IF true THEN RETURN NEW; END IF; '.repeat(n));
  it('accepts nesting up to the limit and refuses beyond it', () => {
    expect(fnRefusedBy(nested(10))).toBeNull();
    expect(fnRefusedBy(nested(30))).toBe('grammar');
  });
  it('accepts a body under 4000 tokens and refuses one over it', () => {
    expect(fnRefusedBy(repeated(400))).toBeNull();
    expect(fnRefusedBy(repeated(480))).toBe('grammar');
  });
  it('lets a function read only tables that the migration set creates', () => {
    const read = (table: string): string => wrap(`SELECT 1 INTO referenced FROM ${table} WHERE ${table}.id = NEW.id;`, DECLARE_VAR);
    expect(fnRefusedBy(read('users'))).toBeNull();
    expect(fnRefusedBy(read('pg_shadow'))).not.toBeNull(); // the deny-net refuses any pg_ name first
    expect(fnRefusedBy(read('secret_table'))).toBe('grammar'); // a plain name that no migration creates: the grammar's own rule
    const withoutUsers: ScanContext = { knownTables: new Set(['facilities']), knownFunctions: realContext.knownFunctions };
    expect(refusedBy(() => validateFunctionChunk(read('users'), withoutUsers))).toBe('grammar');
  });
});

describe('statements outside functions: the same rule, applied to what they embed', () => {
  const ctx: ScanContext = { knownTables: new Set(['users', 'facilities', 'donor_locations', 'request_transitions']), knownFunctions: new Set(['bb_touch_updated_at', 'bb_forbid_delete']) };
  const classify = (sql: string): ScanLayer | null => refusedBy(() => classifyStatement(sql, ctx));

  it('accepts one example of every accepted kind', () => {
    const accepted = [
      'CREATE EXTENSION IF NOT EXISTS postgis;',
      "CREATE TYPE \"public\".\"user_status\" AS ENUM('ACTIVE', 'SUSPENDED');",
      'CREATE TABLE "users" (\n\t"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,\n\t"name" text,\n\t"loc" geography(Point,4326),\n\t"at" timestamp with time zone DEFAULT now() NOT NULL,\n\tCONSTRAINT "u" UNIQUE("name"),\n\tCONSTRAINT "c" CHECK (length(btrim("users"."name")) > 0)\n);',
      'ALTER TABLE "users" ADD CONSTRAINT "users_fk" FOREIGN KEY ("id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;',
      'ALTER TABLE users ADD CONSTRAINT users_no_overlap EXCLUDE USING gist (name WITH =, daterange(a, b, \'[)\') WITH &&) WHERE (scope = \'X\');',
      "CREATE UNIQUE INDEX \"i\" ON \"users\" USING btree (\"id\") WHERE \"users\".\"status\" = 'ACTIVE';",
      'CREATE TRIGGER trg_users_touch BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();',
      'CREATE VIEW donor_locations_coarse AS SELECT donor_id, location_coarse FROM donor_locations;',
      "INSERT INTO request_transitions (from_status, to_status, allowed_actors) VALUES ('DRAFT', 'SUBMITTED', ARRAY['OWNER']::request_actor_kind[]), ('A', 'B', ARRAY['X', 'Y']::request_actor_kind[]);",
    ];
    for (const sql of accepted) expect({ sql: sql.slice(0, 60), layer: classify(sql) }).toEqual({ sql: sql.slice(0, 60), layer: null });
  });

  const refused: Record<string, string[]> = {
    'destructive or unlisted verbs': [
      'DROP TABLE "users";', 'DROP SCHEMA public CASCADE;', 'TRUNCATE "users";', 'DELETE FROM "users";', "UPDATE \"users\" SET status = 'X';", 'GRANT ALL ON ALL TABLES IN SCHEMA public TO PUBLIC;',
      'COMMIT;', 'BEGIN;', 'SET search_path = x;', 'COPY users TO PROGRAM \'id\';', 'VACUUM users;', 'CALL p();', 'DO $$ BEGIN NULL; END $$;', 'SELECT 1;',
    ],
    'alterations that are not ADD CONSTRAINT': [
      'ALTER TABLE "users" DROP COLUMN "status";', 'ALTER TABLE "users" RENAME TO "u";', 'ALTER TABLE "users" ALTER COLUMN "id" SET DATA TYPE text;', 'ALTER TABLE "users" ADD COLUMN "x" text;',
      'ALTER TABLE "users" DISABLE TRIGGER ALL;', 'ALTER TABLE "users" ADD CONSTRAINT "c" NOT VALID;', 'ALTER TABLE "pg_class" ADD CONSTRAINT "c" CHECK (true);', 'ALTER TYPE "public"."x" ADD VALUE \'Y\';',
    ],
    'other CREATE statements': [
      'CREATE EXTENSION IF NOT EXISTS dblink;', 'CREATE EXTENSION postgis;', 'CREATE EXTENSION IF NOT EXISTS "postgis" SCHEMA evil;', 'CREATE TABLE "a" AS SELECT 1;', 'CREATE INDEX CONCURRENTLY "i" ON "users" USING btree ("id");',
      'CREATE OR REPLACE VIEW v AS SELECT 1;', 'CREATE ROLE evil SUPERUSER;', 'CREATE SCHEMA evil;', 'CREATE SEQUENCE s;', 'CREATE POLICY p ON users USING (true);', 'CREATE RULE r AS ON INSERT TO users DO NOTHING;',
    ],
    'more than one statement, or nothing': ['CREATE TABLE "a" ("id" int); DROP TABLE "b";', 'CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS btree_gist;', '', '-- only a comment', ';'],
    'calls hidden in a CHECK, DEFAULT, EXCLUDE or index expression': [
      'CREATE TABLE "a" ("id" int DEFAULT nextval(\'s\'));', 'CREATE TABLE "a" ("id" int, CONSTRAINT "c" CHECK (pg_sleep(60) IS NULL));', 'CREATE TABLE "a" ("id" int, CONSTRAINT "c" CHECK (dblink_exec(\'x\', \'y\') IS NULL));',
      'CREATE TABLE "a" ("id" int DEFAULT random());', 'CREATE TABLE "a" ("id" int, CONSTRAINT "c" CHECK ((SELECT 1) = 1));', 'CREATE TABLE "a" ("id" int DEFAULT "evil"(1));',
      'ALTER TABLE users ADD CONSTRAINT c EXCLUDE USING gist (name WITH =, evil(a) WITH &&);', 'ALTER TABLE users ADD CONSTRAINT c CHECK (set_config(\'a\', \'b\', false) IS NULL);',
      'CREATE INDEX "i" ON "users" USING btree (lower("name"));', 'CREATE INDEX "i" ON "users" USING btree ("id") WHERE pg_sleep(1) IS NULL;', 'CREATE INDEX "i" ON "users" USING evil ("id");',
      'CREATE TABLE "a" ("g" geography(Polygon,4326));', 'CREATE TABLE "a" ("g" varchar(10));',
    ],
    'table shapes with anything after the column list': ['CREATE TABLE "a" ("id" int) INHERITS ("users");', 'CREATE TABLE "a" ("id" int) PARTITION BY RANGE ("id");', 'CREATE TABLE "a" ("id" int) WITH (fillfactor = 10);', 'CREATE TABLE "a" ("id" int) TABLESPACE evil;', 'CREATE TABLE a ("id" int);'],
    'foreign keys and indexes that point outside': [
      'ALTER TABLE "users" ADD CONSTRAINT "f" FOREIGN KEY ("id") REFERENCES "pg_catalog"."pg_class"("oid");', 'ALTER TABLE "users" ADD CONSTRAINT "f" FOREIGN KEY ("id") REFERENCES "public"."secret"("id");',
      'CREATE INDEX "i" ON "pg_class" USING btree ("oid");', 'CREATE INDEX "i" ON "users" USING btree ("id") INCLUDE ("name");', 'CREATE INDEX "i" ON "users" USING btree ("id") WITH (fillfactor = 10);',
    ],
    'triggers that call or attach to something else': [
      'CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION pg_sleep();', 'CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION bb_unknown();', 'CREATE TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();',
      'CREATE TRIGGER t BEFORE INSERT ON users FOR EACH STATEMENT EXECUTE FUNCTION bb_touch_updated_at();', 'CREATE TRIGGER t BEFORE UPDATE OF name ON users FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();',
      'CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW WHEN (true) EXECUTE FUNCTION bb_touch_updated_at();', 'CREATE TRIGGER t BEFORE INSERT ON pg_class FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at();',
      'CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION bb_touch_updated_at(1);', 'CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE PROCEDURE bb_touch_updated_at();',
    ],
    'views that are more than a column list from a known table': [
      'CREATE VIEW v AS SELECT now() FROM users;', 'CREATE VIEW v AS SELECT id FROM pg_shadow;', 'CREATE VIEW v AS SELECT id FROM users WHERE true;', 'CREATE VIEW v AS SELECT id FROM users JOIN facilities ON true;',
      'CREATE VIEW v AS SELECT nextval(\'s\') FROM users;', 'CREATE VIEW v AS SELECT id FROM users UNION SELECT 1;', 'CREATE VIEW v AS SELECT * FROM users;',
    ],
    'inserts that are not the transitions table': [
      "INSERT INTO users (id) VALUES ('x');", "INSERT INTO request_transitions SELECT * FROM users;", "INSERT INTO request_transitions (from_status) VALUES ('A');", "INSERT INTO request_transitions (from_status, to_status, allowed_actors) VALUES ('A', 'B', ARRAY[now()]::request_actor_kind[]);",
      "INSERT INTO request_transitions (from_status, to_status, allowed_actors) VALUES ('a', 'B', ARRAY['X']::request_actor_kind[]);", "INSERT INTO request_transitions (from_status, to_status, allowed_actors) VALUES ('A', 'B', ARRAY['X']::text[]);",
      "INSERT INTO request_transitions (from_status, to_status, allowed_actors) VALUES ('A', 'B', ARRAY['X']::request_actor_kind[]) RETURNING *;", "INSERT INTO request_transitions (from_status, to_status, allowed_actors) VALUES ((SELECT 1), 'B', ARRAY['X']::request_actor_kind[]);",
    ],
    'encoding': ['CREATE TABLE "a" ("id" int);\u0000', 'CREATE TABLE "caf' + E_ACUTE + '" ("id" int);', 'CREATE TABLE "a" ("id" text DEFAULT E\'x\');', "CREATE TABLE \"a\" (\"id\" text DEFAULT $$x$$);"],
  };
  for (const [family, list] of Object.entries(refused)) {
    it(`refuses every statement in: ${family} (${list.length})`, () => {
      for (const sql of list) expect({ sql: sql.slice(0, 80), layer: classify(sql) }).not.toEqual({ sql: sql.slice(0, 80), layer: null });
    });
  }
  it('is a total of at least 75 refused statements outside functions', () => {
    expect(Object.values(refused).flat().length).toBeGreaterThanOrEqual(75);
  });
});

describe('the scanner is a pure module', () => {
  const source = readFileSync(join(import.meta.dirname, '../../scripts/db-migrate-scan.ts'), 'utf8');
  it('imports nothing and touches no file, environment, network or process, and never evaluates text', () => {
    expect(source).not.toMatch(/^import /m);
    expect(source).not.toMatch(/\brequire\(|\bprocess\b|\bfetch\(|\beval\(|new Function|\bchild_process\b|\bfs\b|readFileSync|writeFileSync/);
  });
});
