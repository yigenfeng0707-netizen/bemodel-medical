# BeModel 医疗本体平台（复现版）

对开源项目 [bemodel-java](https://github.com/yueyezhufeng/bemodel-java)（Java 21 + Spring Boot 3.3 + MySQL 8）的**完整功能复现**。

本机无 Java/MySQL 环境，复现版保持**架构、数据模型、API 设计、功能与演示数据完全对齐**，技术栈换为 **Node.js 24（Express 5 + node:sqlite 内置库）+ Vue 3 + Element Plus + ECharts**，零外部数据库依赖，开箱即跑。

```
物理自治 · 逻辑统一 —— 九套医院业务库数据不搬家，通过「本体 + 映射」建统一语义层
```

## 快速开始

要求：Node.js ≥ 22（内置 node:sqlite）。

```bash
# 1. 后端（首次启动自动生成九个演示业务库 + 平台种子数据，确定性可重复）
cd server && npm install && npm start
# → http://127.0.0.1:18080

# 2. 前端
cd web && npm install && npm run dev
# → http://127.0.0.1:5173（/api 已代理到 18080）
```

演示账号（与原版 V26/V29 一致）：

| 账号 | 密码 | 角色 |
|---|---|---|
| admin | admin123 | ADMIN 全部能力 |
| modeler | model123 | EDITOR 建模写操作 |
| reviewer | reviewer123 | REVIEWER 评审/发布（防自审） |
| viewer | viewer123 | VIEWER 只读 |

## 测试（node:test，零外部依赖）

```bash
cd server && npm test   # 110 个测试，node:test + node:sqlite 内置，无需额外依赖
```

- 全部测试使用隔离的 `data-test/` 数据目录（环境变量 `DATA_DIR`），不触碰 `data/` 运行时库，可重复运行。
- 覆盖：纯函数（JSON 容错解析/余弦/切分/状态机/脱敏）、本体集成（16 域 44 概念种子、继承防环、传递闭包、自检）、lab 沙箱（16 表克隆、裂缝数字契约 5 笔/¥205、工具契约）、以及 auth/cs/flow/gov/knowledge/link/release 各模块集成测试。

## LLM 配置（server/.env，已接实测可用源）

当前主备（均为推理模型，单次 25~60s，链路全程 1~3 分钟属正常）：

```ini
LLM_BASE_URL=https://discovery-api.intern-ai.org.cn/v1   # 书生 internAI
LLM_API_KEY=sk-0fec...
LLM_MODEL=intern-s2                                       # 主路（实测 25s/次，JSON 稳定）
LLM_BACKUP_BASE_URL=https://maas-api.cn-huabei-1.xf-yun.com/v2  # 讯飞星火（OpenAI 兼容 /v2）
LLM_BACKUP_API_KEY=ak-...
LLM_BACKUP_MODEL=spark-x2.6                               # 备路
LLM_TIMEOUT_SECONDS=150
```

其余可用资源与状态：阶跃星辰 step_plan 两把 key 均无额度；internAI 另两把 key 无效、fyg199 上 glm-5.3/minimax/deepseek/qwen 配额耗尽（intern-s2 与 Agents-A1 可用，Agents-A1 推理过长弃用）；SenseNova glm-5.2 可用但 RPM/TPM 限制极紧（留作手动备用）；阿里云 token-plan 全模型未购。网关能力：主备路由 + 连续 2 次失败熔断 5 分钟 + 429 退避重试 + 每次尝试落审计表（页面"版本与LLM"可查）。

EMBEDDING_BASE_URL 可选（OpenAI 兼容 /embeddings，已实测接通：书生开发机 A100 上的 bge-m3 fp16，1024 维）：

```bash
# 向量路启动顺序（三件套）：
# 1) 克隆 Chrome（含书生登录态）+ CDP 调试口，会话 1 小时过期后由 relay 自动重铸
#    chrome.exe --remote-debugging-port=9223 --user-data-dir=".chrome-clone/User Data"
# 2) 本机反向代理（监听 11434，经 Jupyter 终端 PTY 隧道转发到开发机 11434）
python scripts/relay_server.py
# 3) 平台后端（EMBEDDING_TIMEOUT_MS=60000，走隧道预留）
cd server && npm start
```

隧道要点（踩坑实录）：Jupyter 终端 WS 直连 URL 少斜杠会 404；PTY 规范模式单行上限 4096（请求 b64 分块写入）；61KB+ 单行长输出会被终端 scrollback 丢头（响应落盘后 base64+fold 成短行回传）；fold 末行可能与 RDONE 粘行（解析时剥离）；会话失效（403）自动调 `scripts/refresh_session.py` 重载控制台页重铸 JWT。知识库新增 `POST /api/knowledge/documents/revectorize` 运维端点，补嵌 NULL 分块。**向量路不可用时全链路诚实降级**为 FTS5 关键词路（bm_llm_log 可查 EMBED_INGEST/EMBED_QUERY 审计），功能不受损。

**无 Key 或限流时全链路诚实降级**为规则/模板（客服关键词路由、映射规则匹配、问数口径卡兜底、RCA 固定结论模板），与原版"绝不编造"的设计一致。

## 复现的功能清单（对应原版模块）

| 模块 | 端点前缀 | 说明 |
|---|---|---|
| 本体建模 | `/api/domain /concept /term /rule /action /axiom /ontology` | 16 域 44 概念、多父继承（防环 DFS）、六类结构公理（对称/传递/函数/逆函数/反对称/互逆）、互斥、传递闭包查询、概念状态机 DRAFT→REVIEW→PUBLISHED→DEPRECATED |
| 发布门禁 | `/api/release` | 10 类自检缺陷（6 BLOCKER + 4 WARN）一票否决、发布快照、传递闭包物化（发布时推理，查询零推理）、审批留痕（approved_by）、OWL/Turtle 导入、版本变更 |
| 数据源绑定 | `/api/datasource /mapping /instance` | 库注册（AES-256-GCM 密文）、物理快照扫描、映射生命周期 PROPOSED→ACTIVE→DEPRECATED + 留痕、AI 推荐绑定（Top-K 预筛 + miss 回流）、概念实例投影（值字典反解 + 姓名脱敏） |
| AI 客服 | `/api/cs` | 意图路由（LLM + 关键词兜底 + 错例反馈回路）、工单 RCA 七步诊断（本体遍历→患者账单→跨库核实→字典裂缝定位→影响面→变更留痕→报告）、一键处置退费、跨库核对六语义档、澄清任务（2 轮封顶回流缺口）、评议 |
| 智能问数 | `/api/cs/ask scene=ANALYTICS` | Ontology2SQL：LLM 生成 SQL → 表/列白名单沙箱 → LIMIT 钳制 → 真执行 → LLM 组织答案；口径卡（口径/公式/探针/阈值/巡检）；UNANSWERABLE 分 A 型歧义（建澄清任务）/ V 型词表缺口（回流 miss） |
| 知识双轨 | `/api/knowledge` | 文档摄取（md/txt/docx/pdf 内置解析）、500/50 切分、向量化（可选）、FTS5 关键词 + 向量余弦 → RRF(k=60) 混合检索；知识条目"改一条走审批" |
| 数据治理 | `/api/gov` | 五类规则探针（PK_UNIQUE/NOT_NULL/DICT_CONSISTENT/REF_INTACT/STOCK_BALANCE）、质量分=加权规则通过率、问题转客服工单 |
| 对账 | `/api/reconcile` | 对账组（多口径实测 + 差额）、归因桶（±sign，matchesDiff=账对上）、下钻钳制、认领/裁决状态机、重跑非零差额自动打回 |
| 链路追溯 | `/api/link /impact` | 节点/边、双向 BFS 追溯、五条种子故事线、自动检测转工单、变更影响多跳分析 |
| 证据链 | `/api/trace` | QA 五段证据（提问→计划→校验→执行→作答）/ 概念全生命周期 / 映射留痕，锚点全平台内可达 |
| 医嘱闭环 | `/api/flow` | 跨九库装配时间线，闭环状态机（CLOSED/CLOSED_CANCELED/BROKEN/PENDING）、门诊同构、人员下钻 |
| 临床质控 | `/api/qc /alert /rdf` | 六类 QC 表达式引擎、SHACL 六 Shape 语义校验（复现版内置实现）、RDF Turtle ABox 导出（姓名脱敏）、危急值预警 |
| 演化闭环 | `/api/ontology/misses /proposal /drift` | 缺口池（4 类来源 upsert 计数）、AI 归类/提案（PENDING→ADOPTED/REJECTED 条件更新防竞态）、语义漂移（术语分叉 + 口径演进快照对比） |
| 实验与沙盘 | `/api/lab /simulation /value` | 三臂同题对照（A=工具循环 JSON 协议 / B=裸 SQL 沙盒 / C=固定功能）、账本审计探针、库存断供传导推演（BFS 波及链 + BLOCKED_GAP 断链诚实呈现）。A 臂工具：qc_check（过敏/剂量/儿童禁忌核查）、patient_search（按姓名找住院号）、drug_dict、fee_gap_scan（取消未退费统计）、status_gap（LIS/HIS 字典裂缝定位）、action_list、exec_refund。四态终态 DONE/BUDGET_CUT/FORMAT_FAILED/LLM_UNAVAILABLE，另有空证据防护 NO_EVIDENCE（未调任何工具就出结论不可信） |
| 巡检告警 | `/api/notice` | 30 分钟定时巡检（幂等告警）、对账组每日巡检、LLM 主备健康 |
| MCP | `POST /mcp` | JSON-RPC，2 个只读工具：ask_data_question / get_metric_card |

## 预埋演示故事（与原版一致）

- **数据裂缝**：LIS v5.2 升级（2026-08-15）撤销码 X→C，HIS 适配器 status_map 缺 C 行 → 5 笔"取消未退费"（¥205）。三处消费口径数字必然一致：QC 探针 / RCA 影响面 / fee_gap_scan。对照组：升级前 X 码 2 笔已正常退费；药品线退药退费联动正常。
- **质控矛盾**：CRP 异常未处置、男性卵巢囊肿（AX-003）、术前缺凝血四项、糖尿病无血糖检验。
- **用药安全**：陈芳头孢过敏开头孢（GATE 实验）、冯雪布洛芬 3g>2.4g 超限、儿童韩小梅开布洛芬缓释胶囊（SHACL Shape3）。
- **链路故事线**：DISPENSE 完整闭环 / 病案有变更无用例 / 危急值闭环 / 退费无立项 / LIS 变更 CAUSES→ 客诉工单。

## 目录结构

```
server/src/
├── index.js          # 装配（路由挂载 + 巡检定时器）
├── config.js db.js schema.sql common.js auth.js llm.js
├── ontology.js       # 本体建模 + 自检 + 缺口/提案/漂移
├── release.js        # 发布门禁 + 闭包物化 + OWL 导入
├── metric.js datasource.js knowledge.js cs.js
├── gov.js            # 治理 + 对账组
├── link.js           # 链路 + 影响 + 证据链
├── flow.js           # 医嘱闭环 + 质控 + RDF/SHACL
├── rca.js misc.js    # RCA / 架构 / 搜索 / 巡检 / lab / 沙盘 / MCP
└── seed/             # demo.js（九库 41 患者全闭环）platform.js（本体种子）
server/test/          # node:test：10 个文件 110 个测试（隔离 data-test/ 目录）
web/src/              # Vue3：18 组页面 + api + store + router
data/                 # 运行时生成：平台库 + 九个演示库（SQLite）
_reference/           # 原仓库源码（研究用）
```

## 与原版的差异（诚实声明）

1. **技术栈**：Java/Spring/MySQL/Jena → Node/Express/SQLite/内置校验；SQLite 单文件库替代 MySQL 多库，探针 SQL 为 SQLite 方言。
2. **SHACL**：Apache Jena SHACL → 按原版 6 个 Shape 语义等价的内置校验器（返回结构一致）。
3. **FTS**：MySQL ngram 全文索引 → SQLite FTS5 + 自实现中文 bigram 查询构造。
4. **对比实验室/沙盘**：沙盒为独立 SQLite 克隆（16 张表：HIS 医嘱/费用/映射、LIS 字典、药房、收费、EMR 过敏），工具循环协议与四态诚实终态（DONE/BUDGET_CUT/FORMAT_FAILED/LLM_UNAVAILABLE）一致。已验证：GATE 三臂同题全 DONE（A=工具循环 3 步 / B=裸 SQL 9 步 / C=固定系统诚实边界），SILO 裂缝定位可复现 5 笔/¥205。
5. 定时任务（30 分钟巡检 / 每日对账）用 setInterval 表达。
6. 原版 45 个 Flyway 迁移整合为单 schema + 运行时 DataSeeder（幂等、确定性、无 Random）。

## 安全提示

演示密钥（JWT_SECRET/APP_SECRET_KEY）为内置 dev 默认值；公网部署前必须替换并启用传输加密；MCP 端点演示期未启用鉴权（与原版拍板一致）。
