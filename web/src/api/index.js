import request from './request';

export const login = (data) => request.post('/auth/login', data);
export const me = () => request.get('/auth/me');

export const listDomains = () => request.get('/domain/list');
export const createDomain = (d) => request.post('/domain', d);
export const listConcepts = (domainCode) => request.get('/concept/list', { params: { domainCode } });
export const conceptDetail = (code) => request.get(`/concept/detail/${code}`);
export const createConcept = (c) => request.post('/concept', c);
export const updateConcept = (c) => request.put('/concept', c);
export const deleteConcept = (code) => request.delete(`/concept/${code}`);
export const transitionConcept = (code, target) => request.post(`/concept/transition/${code}?target=${target}`);
export const addAttribute = (a) => request.post('/concept/attribute', a);
export const deleteAttribute = (id) => request.delete(`/concept/attribute/${id}`);
export const addRelation = (r) => request.post('/concept/relation', r);
export const updateRelation = (id, r) => request.put(`/concept/relation/${id}`, r);
export const deleteRelation = (id) => request.delete(`/concept/relation/${id}`);
export const listParents = (code) => request.get(`/concept/${code}/parents`);
export const addParent = (code, p) => request.post(`/concept/${code}/parents`, p);
export const deleteParent = (code, parentCode) => request.delete(`/concept/${code}/parents/${parentCode}`);
export const setPrimaryParent = (code, parentCode) => request.put(`/concept/${code}/parents/${parentCode}/primary`);
export const listRules = (conceptCode) => request.get('/rule/list', { params: { conceptCode } });
export const createRule = (r) => request.post('/rule', r);
export const updateRule = (id, r) => request.put(`/rule/${id}`, r);
export const deleteRule = (id) => request.delete(`/rule/${id}`);
export const transitionRule = (code, target) => request.post(`/rule/transition/${code}?target=${target}`);
export const listActions = () => request.get('/action/list');
export const createAction = (a) => request.post('/action', a);
export const updateAction = (id, a) => request.put(`/action/${id}`, a);
export const transitionAction = (code, target) => request.post(`/action/transition/${code}?target=${target}`);
export const deleteAction = (id) => request.delete(`/action/${id}`);
export const listAxioms = () => request.get('/axiom/list');
export const createAxiom = (a) => request.post('/axiom', a);
export const deleteAxiom = (id) => request.delete(`/axiom/${id}`);
export const listDisjoint = () => request.get('/ontology/disjoint');
export const addDisjoint = (d) => request.post('/ontology/disjoint', d);
export const deleteDisjoint = (id) => request.delete(`/ontology/disjoint/${id}`);
export const checkOntology = () => request.post('/ontology/check', {});
export const relationClosure = (params) => request.get('/ontology/relation/closure', { params });
export const listMisses = () => request.get('/ontology/misses');
export const missAction = (id, action, data) => request.post(`/ontology/misses/${id}/${action}`, data);
export const classifyMiss = (id) => request.post(`/ontology/misses/${id}/classify`, {});
export const listProposals = (status) => request.get('/proposal/list', { params: { status } });
export const runProposal = () => request.post('/proposal/run', {});
export const adoptProposal = (id) => request.post(`/proposal/${id}/adopt`, {});
export const rejectProposal = (id, reason) => request.post(`/proposal/${id}/reject?reason=${encodeURIComponent(reason || '')}`, {});
export const scanDrift = () => request.get('/drift/scan');
export const owlPreview = (content, filename) => request.post('/ontology/import/preview', { content, filename });
export const owlExecute = (content, filename) => request.post('/ontology/import/execute', { content, filename });

export const listMetrics = () => request.get('/metric/list');
export const saveMetric = (m) => request.put('/metric', m);
export const createMetric = (m) => request.post('/metric', m);
export const evaluateMetric = (code) => request.post(`/metric/evaluate/${code}`);
export const evaluateAllMetrics = () => request.post('/metric/evaluate-all');
export const searchGlossary = (q) => request.get('/search', { params: { q } });
export const listTerms = (conceptCode) => request.get('/term/list', { params: { conceptCode } });
export const createTerm = (t) => request.post('/term', t);
export const deleteTerm = (id) => request.delete(`/term/${id}`);
export const listReconcile = () => request.get('/reconcile/list');
export const runReconcile = (code) => request.post(`/reconcile/run/${code}`);
export const createReconcile = (g) => request.post('/reconcile', g);
export const updateReconcile = (g) => request.put('/reconcile', g);
export const claimReconcile = (code) => request.post(`/reconcile/claim/${code}`);
export const resolveReconcile = (code, data) => request.post(`/reconcile/resolve/${code}`, data);
export const compareReconcile = (code) => request.get(`/reconcile/compare/${code}`);

export const listDatasources = () => request.get('/datasource/list');
export const scanDatasource = (dsCode) => request.post(`/datasource/scan/${dsCode}`);
export const listTables = (dsCode) => request.get(`/datasource/tables/${dsCode}`);
export const listColumns = (dsCode, tableName) => request.get(`/datasource/columns/${dsCode}`, { params: { tableName } });
export const listMappings = (params) => request.get('/mapping/list', { params });
export const saveMappings = (list) => request.post('/mapping/batch', list);
export const updateMapping = (id, m) => request.put(`/mapping/${id}`, m);
export const deleteMapping = (id) => request.delete(`/mapping/${id}`);
export const transitionMapping = (id, target) => request.post(`/mapping/${id}/transition`, { target });
export const mappingLog = (id) => request.get(`/mapping/${id}/log`);
export const aiSuggest = (params) => request.get('/mapping/ai-suggest', { params, timeout: 300000 });
export const listInstances = (conceptCode, params) => request.get(`/instance/${conceptCode}`, { params });

export const listDocuments = () => request.get('/knowledge/documents');
export const uploadDocument = (formData) => request.post('/knowledge/documents', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
export const listChunks = (id) => request.get(`/knowledge/documents/${id}/chunks`);
export const transitionDocument = (id, target) => request.post(`/knowledge/documents/${id}/transition`, { target });
export const deleteDocument = (id) => request.delete(`/knowledge/documents/${id}`);
export const listEntries = () => request.get('/knowledge/entries');
export const createEntry = (e) => request.post('/knowledge/entries', e);
export const updateEntry = (id, e) => request.put(`/knowledge/entries/${id}`, e);
export const transitionEntry = (id, target) => request.post(`/knowledge/entries/${id}/transition`, { target });

export const askCs = (question, scene = 'CS') => request.post('/cs/ask', { question, scene }, { timeout: 300000 });
export const answerClarify = (taskId, supplement) => request.post(`/cs/clarify/${taskId}/answer`, { supplement });
export const listClarify = () => request.get('/cs/clarify/list');
export const submitCsFeedback = (f) => request.post('/cs/feedback', f);
export const listFeedback = (params) => request.get('/cs/feedback/list', { params });
export const listTickets = (params) => request.get('/link/list', { params: { ...params, nodeType: 'TICKET' } });
export const ticketDiagnosis = (id) => request.get(`/cs/ticket/${id}/diagnosis`);
export const refundTicket = (id) => request.post(`/cs/ticket/${id}/refund?operator=客服`);
export const ticketReply = (id) => request.get(`/cs/ticket/customer-reply/${id}`);
export const listReconDiffs = (runId) => request.get('/recon/diffs', { params: { runId } });

export const govOverview = () => request.get('/gov/overview');
export const govTables = () => request.get('/gov/tables');
export const govIssues = (params) => request.get('/gov/issues', { params });
export const runGovScan = () => request.post('/gov/scan');
export const resolveIssue = (id) => request.post(`/gov/issues/${id}/resolve`);
export const issueToTicket = (id) => request.post(`/gov/issues/${id}/ticket`);

export const getTrace = (type, key) => request.get('/trace', { params: { type, key } });

export const listLinks = (params) => request.get('/link/list', { params });
export const linkChain = (code) => request.get(`/link/chain/${code}`);
export const linkChainRels = (code) => request.get(`/link/chain/${code}/rels`);
export const linkTrace = (refNo) => request.get(`/link/trace/${refNo}`);
export const createLinkNode = (n) => request.post('/link', n);
export const createLinkRel = (r) => request.post('/link/rel', r);
export const deleteLinkRel = (id) => request.delete(`/link/rel/${id}`);
export const autoTicket = () => request.post('/link/auto-ticket');
export const analyzeImpact = (d) => request.post('/impact/analyze', d);

export const listFlowPatients = (params) => request.get('/flow/patients', { params });
export const flowLoop = (inhosNo) => request.get(`/flow/loop/${inhosNo}`);
export const listOpdPatients = () => request.get('/flow/opd/patients');
export const opdLoop = (cardNo) => request.get(`/flow/opd/loop/${cardNo}`);
export const staffTrace = (name) => request.get('/flow/staff', { params: { name } });

export const listQcRecords = (params) => request.get('/qc/records', { params });
export const checkQc = (recordId) => request.post(`/qc/check/${recordId}`);
export const checkAllQc = () => request.post('/qc/check-all');
export const getQcResult = (recordId) => request.get(`/qc/result/${recordId}`);
export const validateShacl = (inhosNo) => request.post(`/rdf/validate/${inhosNo}`);
export const detectAlerts = () => request.post('/alert/detect');
export const patientRdfUrl = (inhosNo) => `/api/rdf/patient/${inhosNo}`;

export const listExperiments = () => request.get('/lab/experiments');
export const labStart = (data) => request.post('/lab/run', data);
export const labStatus = (id) => request.get(`/lab/run/${id}`);
export const labRuns = () => request.get('/lab/runs');
export const labReset = () => request.post('/lab/reset');
export const labAudit = () => request.get('/lab/audit');

export const simScenarios = () => request.get('/simulation/scenarios');
export const simStart = (data) => request.post('/simulation/run', data);
export const simStatus = (id) => request.get(`/simulation/run/${id}`);
export const simRuns = () => request.get('/simulation/runs');
export const simReset = () => request.post('/simulation/reset');

export const valueCompare = () => request.get('/value/compare');

export const releaseList = () => request.get('/release/list');
export const releaseCurrent = () => request.get('/release/current');
export const publishRelease = (d) => request.post('/release/publish', d);
export const releaseDetail = (id) => request.get(`/release/${id}`);
export const llmLogList = (params) => request.get('/llm/log/list', { params });
export const llmStats = () => request.get('/llm/stats');
export const llmRoutes = () => request.get('/llm/routes');

export const noticeUnreadCount = () => request.get('/notice/unread-count');
export const noticeList = (params) => request.get('/notice/list', { params });
export const noticeRead = (id) => request.post(`/notice/${id}/read`);
export const noticeReadAll = () => request.post('/notice/read-all');
export const inspectRun = () => request.post('/notice/inspect/run');

export const architectureOverview = () => request.get('/architecture/overview');
