# BeModel 医疗本体平台（复现版）

对开源项目 [bemodel-java](https://github.com/yueyezhufeng/bemodel-java)（Java 21 + Spring Boot 3.3 + MySQL 8）的**完整功能复现**。

本机无 Java/MySQL 环境，复现版保持**架构、数据模型、API 设计、功能与演示数据完全对齐**，技术栈换为 **Node.js 22（Express 5 + PostgreSQL 15）+ Vue 3 + Element Plus + ECharts**。PostgreSQL 随单镜像内置（自装 + 自举建库建表），也可无缝切到外部 RDS；镜像可直接部署魔搭创空间或任意 Docker 环境。

```
物理自治 · 逻辑统一 —— 九套医院业务库数据不搬家，通过「本体 + 映射」建统一语义层
```

## 快速开始

要求：Docker（推荐）或 Node.js ≥ 22 + PostgreSQL ≥ 14。

### 方式一：Docker Compose（推荐）

```bash
# 生产环境必须显式提供密钥（容器入口也会在数据卷内自动生成一份）
JWT_SECRET=请替换 APP_SECRET_KEY=请替换 docker compose up -d --build
# → http://127.0.0.1:7860（前端由后端直接托管，单端口）
```

镜像内自动：初始化 PostgreSQL → 创建平台库与九个业务库 → 建表 → 播种演示数据 → 启动后端并托管前端。

### 方式二：本地开发

```bash
# 1. 准备 PostgreSQL（示例：库 bemodel_platform + 九个业务库由后端自动创建）
#    需一个具备建库权限的账号，默认 bemodel/bemodel@127.0.0.1:5432，可用 PG_* 环境变量覆盖

# 2. 后端（首次启动自动建库建表 + 播种）
cd server && npm install && npm start
# → http://127.0.0.1:7860（PORT 可覆盖，默认 7860）

# 3. 前端开发模式（可选；生产由后端托管 web/dist）
cd web && npm install && npm run dev
# → http://127.0.0.1:5173（/api 已代理到 7860）
```

### 方式三：魔搭创空间

单镜像即可运行，无需外部数据库：

- 端口暴露 `7860`（`PORT` 可覆盖）；
- 持久化目录需挂载到 `/var/lib/postgresql/data`（否则每次重启演示数据与自举密钥会重建）；
- `JWT_SECRET` / `APP_SECRET_KEY` 可不配，入口脚本会在数据卷 `app-secrets/` 下生成并复用。

**线上演示（已部署）**

- 空间主页：https://modelscope.cn/studios/gsym236998/bemodel-medical
- 公网直连：https://gsym236998-bemodel-medical.ms.show
- LLM 主备密钥通过空间 Secrets 注入（`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`，备路 `LLM_BACKUP_*`），**不写入仓库**；`/api/health` 返回 `llm: configured`
- 魔搭网关禁止 `Authorization` 请求头，应用统一使用 `X-Token` 传递登录令牌
- 镜像内前端使用本地预构建 `web/dist`，构建机只装服务端依赖（npm 走 npmmirror，apt 走阿里云）

演示账号（与原版 V26/V29 一致）：

| 账号 | 密码 | 角色 |
|---|---|---|
| admin | admin123 | ADMIN 全部能力 |
| modeler | model123 | EDITOR 建模写操作 |
| reviewer | reviewer123 | REVIEWER 评审/发布（防自审） |
| viewer | viewer123 | VIEWER 只读 |

## 测试（node:test + PostgreSQL）

```bash
cd server && npm test   # 110 个测试，需可连接的 PostgreSQL（PG_HOST/PG_PORT/PG_USER/PG_PASSWORD）
```

- 测试按套件通过 `DATA_DIR` 追加库名后缀（如 `bemodel_platform_data_test_xxx`），自动建库建表、互不污染，可重复运行。
- 并行套件会占用较多连接，PG 建议 `max_connections ≥ 200`（本地验证使用 400）。
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

**镜像内置本地向量端点（默认启用，无需任何外部 Key）**：`embed/` 是一个 OpenAI 兼容 `/v1/embeddings` 微服务（`@huggingface/transformers` + `bge-small-zh-v1.5` ONNX 量化，512 维，CLS pooling + normalize）；模型在镜像构建时下载，容器入口自动拉起并监听 `127.0.0.1:11435`，镜像默认 `EMBEDDING_BASE_URL=http://127.0.0.1:11435/v1`、`EMBEDDING_MODEL=bge-small-zh-v1.5`、`EMBEDDING_TIMEOUT_MS=20000`。要改指外部 embedding 端点，覆盖这三个环境变量即可（此时内置服务不影响主流程）。

外部 embedding 端点同样可用（OpenAI 兼容 /embeddings，已实测接通：书生开发机 A100 上的 bge-m3 fp16，1024 维）：

```bash
# 向量路启动顺序（三件套）：
# 1) 克隆 Chrome（含书生登录态）+ CDP 调试口，会话 1 小时过期后由 relay 自动重铸
#    chrome.exe --remote-debugging-port=9223 --user-data-dir=".chrome-clone/User Data"
# 2) 本机反向代理（监听 11434，经 Jupyter 终端 PTY 隧道转发到开发机 11434）
python scripts/relay_server.py
# 3) 平台后端（EMBEDDING_TIMEOUT_MS=60000，走隧道预留）
cd server && npm start
```

隧道要点（踩坑实录）：Jupyter 终端 WS 直连 URL 少斜杠会 404；PTY 规范模式单行上限 4096（请求 b64 分块写入）；61KB+ 单行长输出会被终端 scrollback 丢头（响应落盘后 base64+fold 成短行回传）；fold 末行可能与 RDONE 粘行（解析时剥离）；会话失效（403）自动调 `scripts/refresh_session.py` 重载控制台页重铸 JWT。知识库启动时自动补齐 NULL 分块向量（`backfillEmbeddings`，重启/重建实例后向量检索依然可用），并提供 `POST /api/knowledge/documents/revectorize` 手动重嵌端点。**向量路不可用时全链路诚实降级**为 PG 关键词路（bm_llm_log 可查 EMBED_INGEST/EMBED_QUERY 审计），功能不受损。

**无 Key 或限流时全链路诚实降级**为规则/模板（客服关键词路由、映射规则匹配、问数口径卡兜底、RCA 固定结论模板），与原版"绝不编造"的设计一致。

## 复现的功能清单（对应原版模块）

| 模块 | 端点前缀 | 说明 |
|---|---|---|
| 本体建模 | `/api/domain /concept /term /rule /action /axiom /ontology` | 16 域 44 概念、多父继承（防环 DFS）、六类结构公理（对称/传递/函数/逆函数/反对称/互逆）、互斥、传递闭包查询、概念状态机 DRAFT→REVIEW→PUBLISHED→DEPRECATED |
| 发布门禁 | `/api/release` | 10 类自检缺陷（6 BLOCKER + 4 WARN）一票否决、发布快照、传递闭包物化（发布时推理，查询零推理）、审批留痕（approved_by）、OWL/Turtle 导入、版本变更 |
| 数据源绑定 | `/api/datasource /mapping /instance` | 库注册（AES-256-GCM 密文）、物理快照扫描、映射生命周期 PROPOSED→ACTIVE→DEPRECATED + 留痕、AI 推荐绑定（Top-K 预筛 + miss 回流）、概念实例投影（值字典反解 + 姓名脱敏） |
| AI 客服 | `/api/cs` | 意图路由（LLM + 关键词兜底 + 错例反馈回路）、工单 RCA 七步诊断（本体遍历→患者账单→跨库核实→字典裂缝定位→影响面→变更留痕→报告）、一键处置退费、跨库核对六语义档、澄清任务（2 轮封顶回流缺口）、评议 |
| 智能问数 | `/api/cs/ask scene=ANALYTICS` | Ontology2SQL：LLM 生成 SQL → 表/列白名单沙箱 → LIMIT 钳制 → 真执行 → LLM 组织答案；口径卡（口径/公式/探针/阈值/巡检）；UNANSWERABLE 分 A 型歧义（建澄清任务）/ V 型词表缺口（回流 miss） |
| 知识双轨 | `/api/knowledge` | 文档摄取（md/txt/docx/pdf 内置解析）、500/50 切分、向量化（可选）、PG 中文 bigram 关键词 + 向量余弦 → RRF(k=60) 混合检索；知识条目"改一条走审批" |
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
├── index.js          # 装配（安全头/限流/路由挂载 + 巡检定时器 + 前端静态托管）
├── config.js db.js pg.js schema.pg.sql common.js auth.js llm.js
├── ontology.js       # 本体建模 + 自检 + 缺口/提案/漂移
├── release.js        # 发布门禁 + 闭包物化 + OWL 导入
├── metric.js datasource.js knowledge.js cs.js
├── gov.js            # 治理 + 对账组
├── link.js           # 链路 + 影响 + 证据链
├── flow.js           # 医嘱闭环 + 质控 + RDF/SHACL
├── rca.js misc.js    # RCA / 架构 / 搜索 / 巡检 / lab / 沙盘 / MCP
├── seed/             # demo.js（九库 41 患者全闭环）platform.js（本体种子）
└── docker/entrypoint.sh  # 容器入口：初始化 PG → 自举密钥 → 启动后端
server/test/          # node:test：10 个文件 110 个测试（按 DATA_DIR 后缀隔离库）
web/src/              # Vue3：18 组页面 + api + store + router
Dockerfile            # 两阶段：前端构建 + 后端/PostgreSQL 单镜像
docker-compose.yml    # 单服务编排（端口 7860 + 数据卷）
_reference/           # 原仓库源码（研究用）
```

## 与原版的差异（诚实声明）

1. **技术栈**：Java/Spring/MySQL/Jena → Node/Express/PostgreSQL/内置校验；PG 多库实例替代 MySQL 多库，探针 SQL 已改写为 PostgreSQL 方言。
2. **SHACL**：Apache Jena SHACL → 按原版 6 个 Shape 语义等价的内置校验器（返回结构一致）。
3. **全文检索**：MySQL ngram 全文索引 → PostgreSQL 中文 bigram + `ILIKE` 子串召回（可选 trgm GIN 索引加速），与向量检索做 RRF 融合。
4. **对比实验室/沙盘**：沙盒为独立 PG 库克隆（16 张表：HIS 医嘱/费用/映射、LIS 字典、药房、收费、EMR 过敏），工具循环协议与四态诚实终态（DONE/BUDGET_CUT/FORMAT_FAILED/LLM_UNAVAILABLE）一致。已验证：GATE 三臂同题全 DONE（A=工具循环 3 步 / B=裸 SQL 9 步 / C=固定系统诚实边界），SILO 裂缝定位可复现 5 笔/¥205。
5. 定时任务（30 分钟巡检 / 每日对账）用 setInterval 表达。
6. 原版 45 个 Flyway 迁移整合为单 schema + 运行时 DataSeeder（幂等、确定性、无 Random）。

## 安全提示

生产环境缺少 `JWT_SECRET` / `APP_SECRET_KEY` / `PG_USER` / `PG_PASSWORD` 时后端拒绝启动；容器入口会在数据卷内自动生成并持久化 JWT/APP 密钥（重建镜像不失效，清卷则换新）。已启用 Helmet 安全响应头、登录接口限流（15 次/分钟）与 CORS 白名单（`CORS_ORIGINS`）；`MCP_API_KEY` 为 MCP 端点必填项：未配置时端点一律拒绝，配置后请求需携带 `X-Api-Key: <key>`（或 `Authorization: Bearer <key>`）。公网部署建议再加传输层加密。
