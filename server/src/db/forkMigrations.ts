import Database from 'better-sqlite3';

export const GOOGLE_API_USAGE_MIGRATION_ID = 'jsnetworkcorp.google_api_usage.v1';
export const PACKING_TEMPLATE_SCOPE_MIGRATION_ID = 'jsnetworkcorp.packing_template_scope.v1';
export const FORK_MIGRATION_IDS = [GOOGLE_API_USAGE_MIGRATION_ID, PACKING_TEMPLATE_SCOPE_MIGRATION_ID] as const;

export const FORK_MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS fork_schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

type TableColumn = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type ForeignKey = {
  table: string;
  from: string;
  to: string;
  on_delete: string;
};

export type PackingTemplateSchemaState = 'legacy' | 'scoped';

function tableSql(db: Database.Database, table: string): string | null {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string }
    | undefined;
  return row?.sql ?? null;
}

function tableColumns(db: Database.Database, table: string): TableColumn[] {
  return db.prepare(`PRAGMA table_info('${table}')`).all() as TableColumn[];
}

export function googleApiUsageSchemaState(db: Database.Database): 'missing' | 'valid' {
  const sql = tableSql(db, 'google_api_usage');
  if (!sql) return 'missing';
  assertGoogleApiUsageSchema(db);
  return 'valid';
}

export function assertGoogleApiUsageSchema(db: Database.Database): void {
  const sql = tableSql(db, 'google_api_usage');
  if (!sql) throw new Error('google_api_usage schema does not match fork migration: table is missing');

  const columns = tableColumns(db, 'google_api_usage');
  const byName = new Map(columns.map((column) => [column.name, column]));
  const errors: string[] = [];
  const expected = [
    ['period', 'TEXT', 1, null, 1],
    ['sku', 'TEXT', 1, null, 2],
    ['attempts', 'INTEGER', 1, '0', 0],
    ['updated_at', 'INTEGER', 1, null, 0],
  ] as const;

  for (const [name, type, notnull, defaultValue, pk] of expected) {
    const column = byName.get(name);
    if (
      !column ||
      column.type.toUpperCase() !== type ||
      column.notnull !== notnull ||
      column.dflt_value !== defaultValue ||
      column.pk !== pk
    ) {
      errors.push(`${name} column contract is invalid`);
    }
  }
  if (columns.length !== expected.length) errors.push(`expected ${expected.length} columns, found ${columns.length}`);
  if (!sql.toLowerCase().replace(/\s+/g, ' ').includes('check (attempts >= 0)')) {
    errors.push('attempts non-negative CHECK is missing');
  }
  if (errors.length > 0) {
    throw new Error(`google_api_usage schema does not match fork migration: ${errors.join('; ')}`);
  }
}

export function packingTemplateSchemaState(db: Database.Database): PackingTemplateSchemaState {
  if (!tableSql(db, 'packing_templates')) {
    throw new Error('packing_templates schema does not match fork migration: table is missing');
  }
  const columns = tableColumns(db, 'packing_templates');
  const hasScope = columns.some((column) => column.name === 'scope');
  const hasOwner = columns.some((column) => column.name === 'owner_id');
  if (!hasScope && !hasOwner) return 'legacy';
  assertPackingTemplateScopeSchema(db);
  return 'scoped';
}

export function assertPackingTemplateScopeSchema(db: Database.Database): void {
  const sql = tableSql(db, 'packing_templates');
  if (!sql) throw new Error('packing_templates schema does not match fork migration: table is missing');

  const errors: string[] = [];
  const columns = tableColumns(db, 'packing_templates');
  const column = (name: string) => columns.find((candidate) => candidate.name === name);
  const scope = column('scope');
  const owner = column('owner_id');
  const creator = column('created_by');

  if (!scope || scope.notnull !== 1 || scope.dflt_value !== "'instance'") {
    errors.push("scope must be NOT NULL DEFAULT 'instance'");
  }
  if (!owner || owner.notnull !== 0) errors.push('owner_id must be nullable');
  if (!creator || creator.notnull !== 0) errors.push('created_by must be nullable');

  const normalizedSql = sql.toLowerCase().replace(/\s+/g, ' ');
  if (!normalizedSql.includes("check (scope in ('instance', 'personal'))")) {
    errors.push('scope enum CHECK is missing');
  }
  if (
    !normalizedSql.includes('packing_templates_scope_owner_check') ||
    !normalizedSql.includes(
      "(scope = 'instance' and owner_id is null) or (scope = 'personal' and owner_id is not null)",
    )
  ) {
    errors.push('scope/owner CHECK is missing');
  }

  const foreignKeys = db.prepare("PRAGMA foreign_key_list('packing_templates')").all() as ForeignKey[];
  if (
    !foreignKeys.some(
      (foreignKey) =>
        foreignKey.from === 'owner_id' &&
        foreignKey.table === 'users' &&
        foreignKey.to === 'id' &&
        foreignKey.on_delete === 'CASCADE',
    )
  ) {
    errors.push('owner_id must reference users(id) ON DELETE CASCADE');
  }
  if (
    !foreignKeys.some(
      (foreignKey) =>
        foreignKey.from === 'created_by' &&
        foreignKey.table === 'users' &&
        foreignKey.to === 'id' &&
        foreignKey.on_delete === 'SET NULL',
    )
  ) {
    errors.push('created_by must reference users(id) ON DELETE SET NULL');
  }

  const index = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_packing_templates_scope_owner_created'")
    .get();
  if (!index) errors.push('scope/owner/created index is missing');

  if (scope && owner) {
    const invalidRows = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM packing_templates
         WHERE scope IS NULL
            OR scope NOT IN ('instance', 'personal')
            OR (scope = 'instance' AND owner_id IS NOT NULL)
            OR (scope = 'personal' AND owner_id IS NULL)`,
      )
      .get() as { count: number };
    if (invalidRows.count > 0) errors.push(`${invalidRows.count} row(s) violate the scope/owner contract`);
  }

  let graphViolations = 0;
  for (const graphTable of ['packing_templates', 'packing_template_categories', 'packing_template_items'] as const) {
    if (!tableSql(db, graphTable)) {
      errors.push(`${graphTable} table is missing`);
      continue;
    }
    graphViolations += db.prepare(`PRAGMA foreign_key_check('${graphTable}')`).all().length;
  }
  if (graphViolations > 0) {
    errors.push(`packing template graph contains ${graphViolations} foreign key violation(s)`);
  }

  if (errors.length > 0) {
    throw new Error(`packing_templates schema does not match fork migration: ${errors.join('; ')}`);
  }
}

function migrateGoogleApiUsage(db: Database.Database): void {
  if (googleApiUsageSchemaState(db) === 'missing') {
    db.exec(`
      CREATE TABLE google_api_usage (
        period TEXT NOT NULL,
        sku TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (period, sku)
      )
    `);
  }
  assertGoogleApiUsageSchema(db);
}

function migratePackingTemplateScope(db: Database.Database): void {
  if (packingTemplateSchemaState(db) === 'scoped') return;

  const foreignKeysEnabled = Number(db.pragma('foreign_keys', { simple: true })) === 1;
  if (foreignKeysEnabled) db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      const before = db.prepare('SELECT COUNT(*) AS count FROM packing_templates').get() as { count: number };
      db.exec(`
        CREATE TABLE packing_templates_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'instance'
            CHECK (scope IN ('instance', 'personal')),
          owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT packing_templates_scope_owner_check CHECK (
            (scope = 'instance' AND owner_id IS NULL) OR
            (scope = 'personal' AND owner_id IS NOT NULL)
          )
        );
        INSERT INTO packing_templates_new
          (id, name, scope, owner_id, created_by, created_at)
        SELECT id, name, 'instance', NULL, created_by, created_at
        FROM packing_templates;
        DROP TABLE packing_templates;
        ALTER TABLE packing_templates_new RENAME TO packing_templates;
        CREATE INDEX idx_packing_templates_scope_owner_created
          ON packing_templates(scope, owner_id, created_at);
      `);
      const after = db.prepare('SELECT COUNT(*) AS count FROM packing_templates').get() as { count: number };
      if (after.count !== before.count) {
        throw new Error(`packing_templates row count changed during migration: ${before.count} -> ${after.count}`);
      }
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error(`packing template scope migration produced ${violations.length} foreign key violation(s)`);
      }
    })();
  } finally {
    if (foreignKeysEnabled) db.exec('PRAGMA foreign_keys = ON');
  }
  assertPackingTemplateScopeSchema(db);
}

const forkMigrations = [
  { id: GOOGLE_API_USAGE_MIGRATION_ID, run: migrateGoogleApiUsage },
  { id: PACKING_TEMPLATE_SCOPE_MIGRATION_ID, run: migratePackingTemplateScope },
] as const;

export function runForkMigrations(db: Database.Database): void {
  db.exec(FORK_MIGRATION_TABLE_SQL);
  const hasMigration = db.prepare('SELECT 1 FROM fork_schema_migrations WHERE id = ?');
  const recordMigration = db.prepare('INSERT INTO fork_schema_migrations (id) VALUES (?)');

  for (const migration of forkMigrations) {
    if (!hasMigration.get(migration.id)) {
      migration.run(db);
      recordMigration.run(migration.id);
    }
  }

  assertGoogleApiUsageSchema(db);
  assertPackingTemplateScopeSchema(db);
}
