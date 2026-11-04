-- BeModel 平台元数据库 schema（整合原版 Flyway V1~V45，SQLite 方言）
CREATE TABLE IF NOT EXISTS bm_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'VIEWER',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_domain (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  sort INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_concept (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  domain_code TEXT NOT NULL,
  definition TEXT,
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  version INTEGER NOT NULL DEFAULT 1,
  iri TEXT UNIQUE,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_attribute (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_code TEXT NOT NULL,
  attr_code TEXT NOT NULL,
  attr_name TEXT NOT NULL,
  data_type TEXT NOT NULL,
  is_key INTEGER DEFAULT 0,
  definition TEXT,
  sort INTEGER DEFAULT 0,
  UNIQUE(concept_code, attr_code)
);

CREATE TABLE IF NOT EXISTS bm_relation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_concept TEXT NOT NULL,
  to_concept TEXT NOT NULL,
  relation_name TEXT NOT NULL,
  description TEXT,
  is_symmetric INTEGER DEFAULT 0,
  is_transitive INTEGER DEFAULT 0,
  is_functional INTEGER DEFAULT 0,
  is_inverse_functional INTEGER DEFAULT 0,
  is_asymmetric INTEGER DEFAULT 0,
  inverse_of TEXT,
  iri TEXT UNIQUE,
  UNIQUE(from_concept, to_concept, relation_name)
);

CREATE TABLE IF NOT EXISTS bm_relation_closure (
  relation_name TEXT NOT NULL,
  from_concept TEXT NOT NULL,
  to_concept TEXT NOT NULL,
  depth INTEGER NOT NULL,
  UNIQUE(relation_name, from_concept, to_concept)
);

CREATE TABLE IF NOT EXISTS bm_concept_parent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_code TEXT NOT NULL,
  parent_code TEXT NOT NULL,
  is_primary INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(child_code, parent_code)
);

CREATE TABLE IF NOT EXISTS bm_concept_disjoint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_a_code TEXT NOT NULL,
  concept_b_code TEXT NOT NULL,
  definition TEXT,
  status TEXT DEFAULT 'PUBLISHED',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(concept_a_code, concept_b_code)
);

CREATE TABLE IF NOT EXISTS bm_axiom (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  axiom_code TEXT UNIQUE,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  axiom_type TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'PUBLISHED',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_term (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL,
  concept_code TEXT NOT NULL,
  source_product TEXT,
  term_type TEXT DEFAULT 'ALIAS',
  code_system TEXT,
  standard_code TEXT,
  UNIQUE(term, source_product)
);

CREATE TABLE IF NOT EXISTS bm_metric (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_code TEXT UNIQUE,
  name TEXT,
  definition TEXT,
  formula TEXT,
  concept_code TEXT,
  owner TEXT,
  ds_code TEXT,
  probe_sql TEXT,
  warn_threshold INTEGER,
  last_val INTEGER,
  last_eval_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_code TEXT UNIQUE,
  name TEXT,
  concept_code TEXT NOT NULL,
  rule_type TEXT,
  expression TEXT,
  metric_code TEXT,
  severity TEXT DEFAULT '中',
  owner TEXT,
  status TEXT DEFAULT 'DRAFT',
  version INTEGER DEFAULT 1,
  engine TEXT,
  expr_json TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_action (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_code TEXT UNIQUE,
  name TEXT,
  concept_code TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  trigger_desc TEXT,
  description TEXT,
  status TEXT DEFAULT 'DRAFT',
  version INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_datasource (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ds_code TEXT UNIQUE,
  ds_name TEXT,
  product_name TEXT,
  db_type TEXT DEFAULT 'SQLITE',
  host TEXT,
  port INTEGER,
  db_name TEXT,
  username TEXT,
  password TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_physical_table (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ds_code TEXT NOT NULL,
  table_name TEXT NOT NULL,
  table_comment TEXT,
  scanned_at TEXT,
  UNIQUE(ds_code, table_name)
);

CREATE TABLE IF NOT EXISTS bm_physical_column (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ds_code TEXT NOT NULL,
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  data_type TEXT,
  column_comment TEXT,
  is_pk INTEGER DEFAULT 0,
  ordinal_position INTEGER,
  UNIQUE(ds_code, table_name, column_name)
);

CREATE TABLE IF NOT EXISTS bm_mapping (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ds_code TEXT NOT NULL,
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  concept_code TEXT NOT NULL,
  attr_code TEXT,
  value_map TEXT,
  confirmed INTEGER DEFAULT 0,
  source TEXT DEFAULT 'MANUAL',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  updated_by TEXT,
  updated_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(ds_code, table_name, column_name, concept_code, attr_code)
);

CREATE TABLE IF NOT EXISTS bm_mapping_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mapping_id INTEGER NOT NULL,
  action TEXT,
  before_json TEXT,
  after_json TEXT,
  operator TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_release (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_tag TEXT UNIQUE,
  change_summary TEXT,
  element_count INTEGER,
  snapshot_json TEXT,
  released_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_llm_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_type TEXT,
  provider TEXT DEFAULT 'primary',
  model TEXT,
  ontology_version TEXT,
  prompt_digest TEXT,
  latency_ms INTEGER,
  success INTEGER,
  err_msg TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_llm_call ON bm_llm_log(call_type);
CREATE INDEX IF NOT EXISTS idx_llm_time ON bm_llm_log(created_at);

CREATE TABLE IF NOT EXISTS bm_gov_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_code TEXT UNIQUE,
  rule_name TEXT,
  rule_type TEXT,
  concept_code TEXT NOT NULL,
  severity TEXT DEFAULT '中',
  expr_json TEXT NOT NULL,
  status TEXT DEFAULT 'PUBLISHED',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_gov_scan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_time TEXT,
  duration_ms INTEGER,
  rule_count INTEGER,
  issue_count INTEGER,
  quality_score INTEGER
);

CREATE TABLE IF NOT EXISTS bm_gov_issue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL,
  rule_code TEXT, rule_name TEXT, rule_type TEXT, severity TEXT,
  concept_code TEXT, ds_code TEXT, table_name TEXT,
  hit_count INTEGER, sample_json TEXT,
  status TEXT DEFAULT '未处理',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_govissue_scan ON bm_gov_issue(scan_id);

CREATE TABLE IF NOT EXISTS bm_recon_diff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  direction TEXT,
  state_code TEXT,
  severity TEXT,
  attribution TEXT,
  suggested_action TEXT,
  patient_no TEXT,
  order_id TEXT,
  item_name TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_recondiff_run ON bm_recon_diff(run_id);
CREATE INDEX IF NOT EXISTS idx_recondiff_state ON bm_recon_diff(state_code);

CREATE TABLE IF NOT EXISTS bm_reconcile_group (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_code TEXT UNIQUE,
  name TEXT,
  definition TEXT,
  metric_codes TEXT NOT NULL,
  drill_ds_code TEXT,
  drill_sql TEXT,
  owner TEXT,
  dispute_status TEXT DEFAULT 'OPEN',
  dispute_owner TEXT,
  verdict TEXT,
  verdict_note TEXT,
  verdict_at TEXT,
  buckets_json TEXT,
  scheduled INTEGER DEFAULT 0,
  claimed_by TEXT,
  resolved_by TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_reconcile_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_code TEXT NOT NULL,
  values_json TEXT,
  diff_value INTEGER,
  drill_json TEXT,
  drill_count INTEGER,
  buckets_json TEXT,
  error_msg TEXT,
  ran_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_ontology_miss (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT,
  count INTEGER DEFAULT 1,
  dismissed INTEGER DEFAULT 0,
  dismiss_reason TEXT,
  adopted_concept_code TEXT,
  adopted_as TEXT,
  revoked INTEGER DEFAULT 0,
  first_seen TEXT DEFAULT (datetime('now','localtime')),
  last_seen TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(term, kind)
);
CREATE INDEX IF NOT EXISTS idx_miss_disp ON bm_ontology_miss(dismissed, count);

CREATE TABLE IF NOT EXISTS bm_proposal_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scanned INTEGER, generated_cnt INTEGER, llm_failed INTEGER,
  message TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_ontology_proposal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  primary_miss_id INTEGER NOT NULL,
  miss_ids TEXT NOT NULL,
  term TEXT,
  signal_count INTEGER,
  action TEXT,
  target_concept_code TEXT,
  suggestion_json TEXT,
  status TEXT DEFAULT 'PENDING',
  decided_by TEXT, decided_at TEXT, reject_reason TEXT,
  run_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_prop_status ON bm_ontology_proposal(status);

CREATE TABLE IF NOT EXISTS link_node (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_type TEXT NOT NULL,
  ref_no TEXT UNIQUE,
  title TEXT,
  concept_code TEXT NOT NULL,
  status TEXT,
  occurred_at TEXT,
  payload TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_linknode_concept ON link_node(concept_code);

CREATE TABLE IF NOT EXISTS link_rel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_ref_no TEXT NOT NULL,
  to_ref_no TEXT NOT NULL,
  rel_type TEXT NOT NULL,
  remark TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(from_ref_no, to_ref_no, rel_type)
);

CREATE TABLE IF NOT EXISTS rca_case (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no TEXT UNIQUE,
  ticket_ref TEXT,
  concept_code TEXT,
  status TEXT DEFAULT 'RUNNING',
  conclusion TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS rca_step (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  step_no INTEGER,
  step_name TEXT, step_type TEXT, sql_text TEXT,
  hit_count INTEGER, result_json TEXT,
  status TEXT DEFAULT 'SUCCESS',
  started_at TEXT, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rcastep_case ON rca_step(case_id);

CREATE TABLE IF NOT EXISTS rca_report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER UNIQUE,
  root_cause TEXT,
  evidence_json TEXT, impact_json TEXT, suggestions_json TEXT,
  llm_used INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS qc_result (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  inhos_no TEXT,
  record_type TEXT,
  pass_flag INTEGER,
  findings_json TEXT,
  trace_json TEXT,
  llm_used INTEGER,
  llm_summary TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_qc_record ON qc_result(record_id);

CREATE TABLE IF NOT EXISTS bm_cs_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  intent TEXT,
  router TEXT,
  correct INTEGER,
  comment TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_csfb ON bm_cs_feedback(correct, id);

CREATE TABLE IF NOT EXISTS bm_clarify_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene TEXT,
  origin_question TEXT NOT NULL,
  reason TEXT,
  gap_type TEXT,
  clarify_question TEXT NOT NULL,
  status TEXT DEFAULT 'PENDING',
  supplement TEXT,
  rounds INTEGER DEFAULT 1,
  miss_id INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  answered_at TEXT, closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_clarify_status ON bm_clarify_task(status);

CREATE TABLE IF NOT EXISTS bm_qa_trace (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  scene TEXT,
  question TEXT NOT NULL,
  ds_code TEXT,
  used_tables TEXT,
  sql_text TEXT,
  semantics TEXT,
  matched_concepts TEXT,
  matched_docs TEXT,
  plan_mode TEXT,
  row_count INTEGER,
  answer TEXT,
  answer_source TEXT NOT NULL DEFAULT 'TEMPLATE',
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_qatrace ON bm_qa_trace(trace_id);

CREATE TABLE IF NOT EXISTS bm_document (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT, doc_type TEXT, source TEXT DEFAULT 'UPLOAD',
  status TEXT DEFAULT 'DRAFT', version INTEGER DEFAULT 1,
  owner TEXT, uploaded_by TEXT, file_size INTEGER,
  content_hash TEXT, content_text TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_doc_hash ON bm_document(content_hash);
CREATE INDEX IF NOT EXISTS idx_doc_status ON bm_document(status);

CREATE TABLE IF NOT EXISTS bm_doc_chunk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL,
  seq INTEGER,
  heading TEXT,
  content TEXT NOT NULL,
  embedding TEXT,
  concept_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_docchunk_doc ON bm_doc_chunk(document_id);
CREATE VIRTUAL TABLE IF NOT EXISTS bm_doc_chunk_fts USING fts5(content, tokenize='unicode61');

CREATE TABLE IF NOT EXISTS bm_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  title TEXT, content TEXT NOT NULL,
  applies_to TEXT, concept_code TEXT,
  source TEXT DEFAULT 'SEED', status TEXT DEFAULT 'DRAFT',
  version INTEGER DEFAULT 1, owner TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_alert_notice (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_code TEXT NOT NULL, metric_name TEXT,
  actual_value INTEGER, threshold INTEGER,
  message TEXT, status TEXT DEFAULT '未读',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_alert_status ON bm_alert_notice(status, metric_code);

CREATE TABLE IF NOT EXISTS bm_inspect_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evaluated INTEGER, alarmed INTEGER, notices_created INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bm_lab_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_key TEXT NOT NULL,
  question TEXT, force_execute INTEGER DEFAULT 1,
  status TEXT DEFAULT 'QUEUED',
  payload_json TEXT, error_msg TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_labrun_exp ON bm_lab_run(experiment_key);

CREATE TABLE IF NOT EXISTS bm_simulation_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario TEXT, status TEXT DEFAULT 'QUEUED',
  payload_json TEXT, error_msg TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS bm_mcp_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool TEXT, args_json TEXT, ok INTEGER, note TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
