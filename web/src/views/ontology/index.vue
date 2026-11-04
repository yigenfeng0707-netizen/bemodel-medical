<template>
  <div class="page">
    <el-tabs v-model="tab">
      <!-- ============ 全局图谱 ============ -->
      <el-tab-pane label="图谱" name="graph" lazy>
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <b>概念关系图谱</b>
              <div style="display:flex;gap:8px;align-items:center">
                <el-select v-model="graphDomain" placeholder="全部业务域" clearable size="small" style="width:160px">
                  <el-option v-for="d in domains" :key="d.code" :label="d.name" :value="d.code" />
                </el-select>
                <el-input v-model="graphKeyword" placeholder="搜索概念…" clearable size="small" style="width:180px" />
              </div>
            </div>
          </template>
          <div style="font-size:12px;color:var(--text-3);margin-bottom:6px">拖拽平移 · 滚轮缩放 · 点节点查看概念详情 · 节点颜色 = 业务域 · 大小 = 生效映射数</div>
          <GraphCanvas :nodes="kgNodes" :edges="kgEdges" layout="force" height="640px" :tooltip-formatter="kgTip" @node-click="(d) => openDetail({ code: d.raw.code })" />
        </el-card>
      </el-tab-pane>
      <!-- ============ 概念建模 ============ -->
      <el-tab-pane label="概念建模" name="concept">
        <el-row :gutter="12">
          <el-col :span="6">
            <el-card shadow="never">
              <template #header><div class="card-header"><b>业务域</b><el-button size="small" :disabled="isViewer" @click="domainDlg = true">新建域</el-button></div></template>
              <el-tree :data="domainTree" :props="{ label: 'name', children: 'children' }" @node-click="onDomainClick">
                <template #default="{ data }">
                  <span :class="{ 'domain-active': data.code === curDomain }">{{ data.name }}</span>
                  <span class="mono" style="color:var(--text-3);margin-left:6px">{{ data.children ? '' : data.code }}</span>
                </template>
              </el-tree>
            </el-card>
          </el-col>
          <el-col :span="18">
            <el-card shadow="never">
              <template #header>
                <div class="card-header">
                  <b>概念（{{ concepts.length }}）</b>
                  <div>
                    <el-badge :value="missCount" :hidden="!missCount" class="mr8">
                      <el-button size="small" @click="proposalDrawer = true; loadMisses()">扩展提案</el-button>
                    </el-badge>
                    <el-button size="small" @click="owlDlg = true">导入 OWL</el-button>
                    <el-button size="small" type="primary" :disabled="isViewer" @click="openConcept()">新建概念</el-button>
                  </div>
                </div>
              </template>
              <el-table :data="pagedConcepts" size="small" @row-click="openDetail" highlight-current-row>
                <el-table-column prop="code" label="编码" width="200" class-name="mono" />
                <el-table-column prop="name" label="名称" width="140" />
                <el-table-column prop="domain_code" label="域" width="140" />
                <el-table-column prop="owner" label="负责人" width="110" />
                <el-table-column label="状态" width="100">
                  <template #default="{ row }"><el-tag size="small" :type="statusTag(row.status)">{{ statusText(row.status) }}</el-tag></template>
                </el-table-column>
                <el-table-column prop="version" label="版本" width="70" />
                <el-table-column prop="definition" label="定义" show-overflow-tooltip />
              </el-table>
              <el-pagination v-model:current-page="page" :page-size="20" :total="concepts.length" layout="prev, pager, next" style="margin-top:10px" />
            </el-card>
          </el-col>
        </el-row>

        <el-drawer v-model="detailDrawer" size="55%" :title="detail?.concept ? `${detail.concept.code}（${detail.concept.name}）` : ''">
          <el-tabs v-if="detail" v-model="innerTab">
            <el-tab-pane label="属性" name="attr">
              <el-button size="small" type="primary" :disabled="isViewer" class="mb12" @click="attrDlg = true">新增属性</el-button>
              <el-table :data="detail.attributes" size="small">
                <el-table-column prop="attr_code" label="编码" class-name="mono" />
                <el-table-column prop="attr_name" label="名称" />
                <el-table-column prop="data_type" label="类型" width="90" />
                <el-table-column label="主键" width="70"><template #default="{ row }">{{ row.is_key ? '✔' : '' }}</template></el-table-column>
                <el-table-column prop="definition" label="说明" show-overflow-tooltip />
                <el-table-column label="" width="60"><template #default="{ row }"><el-button size="small" text type="danger" :disabled="isViewer" @click="delAttr(row)">删除</el-button></template></el-table-column>
              </el-table>
            </el-tab-pane>
            <el-tab-pane label="关系" name="rel">
              <el-button size="small" type="primary" :disabled="isViewer" class="mb12" @click="openRelDlg()">新建关系</el-button>
              <el-table :data="detail.relations" size="small">
                <el-table-column label="关系" min-width="220">
                  <template #default="{ row }">{{ row.from_concept }} —{{ row.relation_name }}→ {{ row.to_concept }}</template>
                </el-table-column>
                <el-table-column label="公理" min-width="180">
                  <template #default="{ row }">
                    <el-tag v-for="a in axiomFlags(row)" :key="a" size="small" class="mr4">{{ a }}</el-tag>
                    <el-tag v-if="row.inverse_of" size="small" type="warning">⇄ {{ row.inverse_of }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="description" label="说明" show-overflow-tooltip />
                <el-table-column label="" width="110">
                  <template #default="{ row }">
                    <el-button size="small" text :disabled="isViewer" @click="openRelDlg(row)">编辑</el-button>
                    <el-button size="small" text type="danger" :disabled="isViewer" @click="delRel(row)">删除</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </el-tab-pane>
            <el-tab-pane label="继承" name="parent">
              <el-button size="small" type="primary" :disabled="isViewer" class="mb12" @click="parentDlg = true">添加父概念</el-button>
              <el-table :data="detail.parents" size="small">
                <el-table-column prop="parent_code" label="父概念" />
                <el-table-column prop="parent_name" label="名称" />
                <el-table-column label="主父" width="80"><template #default="{ row }">{{ row.is_primary ? '✔' : '' }}</template></el-table-column>
                <el-table-column label="" width="140">
                  <template #default="{ row }">
                    <el-button size="small" text :disabled="isViewer || row.is_primary" @click="setPrimary(row)">设为主父</el-button>
                    <el-button size="small" text type="danger" :disabled="isViewer" @click="delParent(row)">删除</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </el-tab-pane>
            <el-tab-pane label="图" name="graph">
              <GraphCanvas :nodes="graphNodes" :edges="graphEdges" layout="force" height="380px" @node-click="(d) => openDetail({ code: d.id })" />
              <div class="mb12" style="margin-top:8px;display:flex;gap:8px;align-items:center">
                <el-select v-model="closureRel" placeholder="选传递关系看闭包" size="small" style="width:200px" clearable>
                  <el-option v-for="r in transitiveRels" :key="r" :label="r" :value="r" />
                </el-select>
                <el-button size="small" @click="loadClosure">查传递闭包</el-button>
              </div>
              <div v-if="closureRows.length">
                <el-tag v-for="g in closureGroups" :key="g.depth" class="mr4" size="small" type="info">第 {{ g.depth }} 跳：{{ g.items.join('、') }}</el-tag>
              </div>
            </el-tab-pane>
            <el-tab-pane label="互斥" name="disjoint">
              <el-button size="small" type="primary" :disabled="isViewer" class="mb12" @click="disjointDlg = true">新增互斥</el-button>
              <el-table :data="detail.disjoint" size="small">
                <el-table-column label="互斥对"><template #default="{ row }">{{ row.concept_a_code }} ✕ {{ row.concept_b_code }}</template></el-table-column>
                <el-table-column prop="definition" label="理由" show-overflow-tooltip />
                <el-table-column label="" width="70"><template #default="{ row }"><el-button size="small" text type="danger" :disabled="isViewer" @click="delDisjoint(row)">删除</el-button></template></el-table-column>
              </el-table>
            </el-tab-pane>
            <el-tab-pane label="术语" name="term">
              <el-tag v-for="t in detail.terms" :key="t.id" class="mr4 mb4" size="small">{{ t.term }}（{{ t.source_product }}）</el-tag>
              <el-empty v-if="!detail.terms.length" description="暂无术语" :image-size="60" />
            </el-tab-pane>
            <el-tab-pane label="操作" name="ops">
              <el-steps :active="stepActive(detail.concept.status)" align-center class="mb12">
                <el-step title="草稿" /><el-step title="评审中" /><el-step title="已发布" /><el-step title="已废弃" />
              </el-steps>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <el-button v-if="detail.concept.status === 'DRAFT'" size="small" type="primary" :disabled="isViewer" @click="transition('REVIEW')">提交评审</el-button>
                <el-button v-if="detail.concept.status === 'REVIEW'" size="small" type="success" :disabled="!canReview" @click="transition('PUBLISHED')">发布</el-button>
                <el-button v-if="detail.concept.status === 'REVIEW'" size="small" :disabled="isViewer" @click="transition('DRAFT')">退回草稿</el-button>
                <el-button v-if="['DRAFT', 'REVIEW', 'PUBLISHED'].includes(detail.concept.status)" size="small" type="danger" plain :disabled="!canReview && detail.concept.status === 'PUBLISHED'" @click="transition('DEPRECATED')">废弃</el-button>
                <el-button v-if="detail.concept.status === 'DEPRECATED'" size="small" :disabled="isViewer" @click="transition('DRAFT')">重建为草稿</el-button>
                <el-button size="small" :disabled="isViewer" @click="openConcept(detail.concept)">编辑概念</el-button>
                <el-button v-if="detail.concept.status === 'DRAFT'" size="small" type="danger" :disabled="isViewer" @click="delConcept">删除</el-button>
              </div>
            </el-tab-pane>
          </el-tabs>
        </el-drawer>

        <!-- 新建/编辑概念 -->
        <el-dialog v-model="conceptDlg" :title="conceptForm.code && editMode ? '编辑概念' : '新建概念'" width="520px">
          <el-form label-width="80px">
            <el-form-item label="编码"><el-input v-model="conceptForm.code" :disabled="editMode" placeholder="大写蛇形，如 INP_VISIT" /></el-form-item>
            <el-form-item label="名称"><el-input v-model="conceptForm.name" /></el-form-item>
            <el-form-item label="业务域"><el-select v-model="conceptForm.domainCode" style="width:100%"><el-option v-for="d in domains" :key="d.code" :label="`${d.code} ${d.name}`" :value="d.code" /></el-select></el-form-item>
            <el-form-item label="定义"><el-input v-model="conceptForm.definition" type="textarea" :rows="2" /></el-form-item>
            <el-form-item label="负责人"><el-input v-model="conceptForm.owner" /></el-form-item>
            <el-form-item label="IRI"><el-input v-model="conceptForm.iri" placeholder="外部本体 IRI（可空）" /></el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="conceptDlg = false">取消</el-button>
            <el-button type="primary" @click="saveConcept">保存</el-button>
          </template>
        </el-dialog>
        <el-dialog v-model="domainDlg" title="新建业务域" width="440px">
          <el-form label-width="70px">
            <el-form-item label="编码"><el-input v-model="domainForm.code" /></el-form-item>
            <el-form-item label="名称"><el-input v-model="domainForm.name" /></el-form-item>
            <el-form-item label="说明"><el-input v-model="domainForm.description" /></el-form-item>
          </el-form>
          <template #footer><el-button @click="domainDlg = false">取消</el-button><el-button type="primary" @click="saveDomain">保存</el-button></template>
        </el-dialog>
        <el-dialog v-model="attrDlg" title="新增属性" width="480px">
          <el-form label-width="70px">
            <el-form-item label="编码"><el-input v-model="attrForm.attrCode" /></el-form-item>
            <el-form-item label="名称"><el-input v-model="attrForm.attrName" /></el-form-item>
            <el-form-item label="类型"><el-select v-model="attrForm.dataType"><el-option value="STRING" /><el-option value="NUMBER" /><el-option value="DATE" /><el-option value="ENUM" /></el-select></el-form-item>
            <el-form-item label="主键"><el-switch v-model="attrForm.isKey" /></el-form-item>
            <el-form-item label="说明"><el-input v-model="attrForm.definition" /></el-form-item>
          </el-form>
          <template #footer><el-button @click="attrDlg = false">取消</el-button><el-button type="primary" @click="saveAttr">保存</el-button></template>
        </el-dialog>
        <el-dialog v-model="relDlg" :title="relForm.id ? '编辑关系' : '新建关系'" width="560px">
          <el-form label-width="90px">
            <el-form-item label="起点概念"><el-select v-model="relForm.fromConcept" filterable style="width:100%"><el-option v-for="c in conceptStore.concepts" :key="c.code" :label="`${c.code} ${c.name}`" :value="c.code" /></el-select></el-form-item>
            <el-form-item label="关系名"><el-input v-model="relForm.relationName" /></el-form-item>
            <el-form-item label="终点概念"><el-select v-model="relForm.toConcept" filterable style="width:100%"><el-option v-for="c in conceptStore.concepts" :key="c.code" :label="`${c.code} ${c.name}`" :value="c.code" /></el-select></el-form-item>
            <el-form-item label="公理">
              <el-checkbox v-model="relForm.isSymmetric" true-value="1" false-value="0">对称</el-checkbox>
              <el-checkbox v-model="relForm.isTransitive" true-value="1" false-value="0">传递</el-checkbox>
              <el-checkbox v-model="relForm.isFunctional" true-value="1" false-value="0">函数</el-checkbox>
              <el-checkbox v-model="relForm.isInverseFunctional" true-value="1" false-value="0">逆函数</el-checkbox>
              <el-checkbox v-model="relForm.isAsymmetric" true-value="1" false-value="0">反对称</el-checkbox>
            </el-form-item>
            <el-form-item label="互逆关系"><el-input v-model="relForm.inverseOf" placeholder="对方关系名" /></el-form-item>
            <el-form-item label="说明"><el-input v-model="relForm.description" type="textarea" :rows="2" /></el-form-item>
          </el-form>
          <template #footer><el-button @click="relDlg = false">取消</el-button><el-button type="primary" @click="saveRel">保存</el-button></template>
        </el-dialog>
        <el-dialog v-model="parentDlg" title="添加父概念" width="420px">
          <el-form label-width="90px">
            <el-form-item label="父概念">
              <el-select v-model="parentForm.parentCode" filterable style="width:100%">
                <el-option v-for="c in parentCandidates" :key="c.code" :label="`${c.code} ${c.name}`" :value="c.code" />
              </el-select>
            </el-form-item>
            <el-form-item label="设为主父"><el-switch v-model="parentForm.isPrimary" /></el-form-item>
          </el-form>
          <template #footer><el-button @click="parentDlg = false">取消</el-button><el-button type="primary" @click="saveParent">保存</el-button></template>
        </el-dialog>
        <el-dialog v-model="disjointDlg" title="新增互斥公理" width="440px">
          <el-form label-width="80px">
            <el-form-item label="概念 A"><el-select v-model="disjointForm.a" filterable style="width:100%"><el-option v-for="c in conceptStore.concepts" :key="c.code" :label="c.code" :value="c.code" /></el-select></el-form-item>
            <el-form-item label="概念 B"><el-select v-model="disjointForm.b" filterable style="width:100%"><el-option v-for="c in conceptStore.concepts" :key="c.code" :label="c.code" :value="c.code" /></el-select></el-form-item>
            <el-form-item label="理由"><el-input v-model="disjointForm.definition" type="textarea" /></el-form-item>
          </el-form>
          <template #footer><el-button @click="disjointDlg = false">取消</el-button><el-button type="primary" @click="saveDisjoint">保存</el-button></template>
        </el-dialog>
        <el-dialog v-model="owlDlg" title="导入 OWL / Turtle 本体" width="640px">
          <el-upload drag :auto-upload="false" :limit="1" :on-change="(f) => owlFile = f.raw" accept=".owl,.rdf,.ttl">
            <el-icon style="font-size:32px"><UploadFilled /></el-icon>
            <div>拖拽 .owl / .rdf / .ttl 文件</div>
          </el-upload>
          <el-button class="mb12" style="margin-top:10px" :disabled="!owlFile" :loading="owlLoading" @click="doOwlPreview">解析预览</el-button>
          <div v-if="owlPlan">
            <el-alert :title="`新增 ${owlPlan.summary.created} / 更新 ${owlPlan.summary.updated} / 跳过 ${owlPlan.summary.skipped}`" type="info" class="mb12" />
            <el-alert v-if="owlPlan.unprojected.length" :title="`${owlPlan.unprojected.length} 个未投影要素（disjointWith/Restriction 等）`" type="warning" class="mb12" />
            <el-table :data="owlPlan.items" size="small" max-height="260">
              <el-table-column prop="kind" label="类型" width="100" />
              <el-table-column prop="name" label="名称" />
              <el-table-column prop="disposition" label="处置" width="140" />
              <el-table-column prop="code" label="编码" class-name="mono" />
            </el-table>
          </div>
          <template #footer>
            <el-button @click="owlDlg = false">取消</el-button>
            <el-button type="primary" :disabled="!owlPlan" @click="doOwlExecute">确认导入</el-button>
          </template>
        </el-dialog>
      </el-tab-pane>

      <!-- ============ 规则 ============ -->
      <el-tab-pane label="规则" name="rule" lazy>
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <b>业务规则（含 QC 表达式引擎）</b>
              <el-button size="small" type="primary" :disabled="isViewer" @click="openRule()">新建规则</el-button>
            </div>
          </template>
          <el-table :data="rules" size="small">
            <el-table-column prop="rule_code" label="编码" width="150" class-name="mono" />
            <el-table-column prop="name" label="名称" min-width="160" />
            <el-table-column prop="concept_code" label="概念" width="140" />
            <el-table-column label="驱动" width="110">
              <template #default="{ row }"><el-tag size="small" :type="row.engine === 'QC' ? 'warning' : 'info'">{{ row.engine === 'QC' ? '表达式驱动' : (row.metric_code ? '指标监控' : '声明式') }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="severity" label="严重度" width="80" />
            <el-table-column prop="owner" label="负责人" width="100" />
            <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag size="small" :type="statusTag(row.status)">{{ statusText(row.status) }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="220">
              <template #default="{ row }">
                <el-button v-if="row.status === 'DRAFT'" size="small" text :disabled="isViewer" @click="trRule(row, 'REVIEW')">提交评审</el-button>
                <el-button v-if="row.status === 'REVIEW'" size="small" text type="success" :disabled="!canReview" @click="trRule(row, 'PUBLISHED')">发布</el-button>
                <el-button v-if="row.status === 'PUBLISHED'" size="small" text type="danger" :disabled="!canReview" @click="trRule(row, 'DEPRECATED')">废弃</el-button>
                <el-button v-if="row.status === 'DEPRECATED'" size="small" text :disabled="isViewer" @click="trRule(row, 'DRAFT')">重建</el-button>
                <el-button size="small" text @click="ruleExprDlg = row">查看表达式</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
        <el-dialog v-model="ruleDlg" title="新建规则" width="640px">
          <el-form label-width="90px">
            <el-form-item label="编码"><el-input v-model="ruleForm.ruleCode" /></el-form-item>
            <el-form-item label="名称"><el-input v-model="ruleForm.name" /></el-form-item>
            <el-form-item label="概念"><el-select v-model="ruleForm.conceptCode" filterable style="width:100%"><el-option v-for="c in conceptStore.concepts" :key="c.code" :label="c.code" :value="c.code" /></el-select></el-form-item>
            <el-form-item label="引擎"><el-switch v-model="ruleForm.engineQC" active-text="QC 表达式" inactive-text="声明式" /></el-form-item>
            <el-form-item label="表达式 JSON" v-if="ruleForm.engineQC"><el-input v-model="ruleForm.exprJson" type="textarea" :rows="6" class="mono" placeholder='{"type":"DIAG_REQUIRES_ITEM","diagKeywords":["糖尿病"],"itemCodes":["L005"]}' /></el-form-item>
            <el-form-item label="声明式" v-else><el-input v-model="ruleForm.expression" type="textarea" :rows="3" /></el-form-item>
            <el-form-item label="严重度"><el-select v-model="ruleForm.severity"><el-option value="高" /><el-option value="中" /><el-option value="低" /></el-select></el-form-item>
          </el-form>
          <template #footer><el-button @click="ruleDlg = false">取消</el-button><el-button type="primary" @click="saveRule">保存草稿</el-button></template>
        </el-dialog>
        <el-dialog :model-value="!!ruleExprDlg" :title="ruleExprDlg?.rule_code" width="560px" @update:model-value="ruleExprDlg = null">
          <pre class="json-block">{{ pretty(ruleExprDlg?.expr_json || ruleExprDlg?.expression) }}</pre>
        </el-dialog>
      </el-tab-pane>

      <!-- ============ 动作 ============ -->
      <el-tab-pane label="动作" name="action" lazy>
        <el-card shadow="never">
          <template #header><div class="card-header"><b>动作（概念状态机）</b><span style="font-size:12px;color:var(--text-3)">已发布动作是 AI 与自动化的白名单能力边界</span></div></template>
          <el-table :data="actions" size="small">
            <el-table-column prop="action_code" label="编码" width="180" class-name="mono" />
            <el-table-column prop="name" label="动作" width="120" />
            <el-table-column prop="concept_code" label="作用概念" width="160" />
            <el-table-column label="状态迁移" min-width="200">
              <template #default="{ row }">{{ row.from_status || '（任意）' }} → {{ row.to_status }}</template>
            </el-table-column>
            <el-table-column prop="trigger_desc" label="触发" width="140" />
            <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag size="small" :type="statusTag(row.status)">{{ statusText(row.status) }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="200">
              <template #default="{ row }">
                <el-button v-if="row.status === 'DRAFT'" size="small" text :disabled="isViewer" @click="trAction(row, 'REVIEW')">提交评审</el-button>
                <el-button v-if="row.status === 'REVIEW'" size="small" text type="success" :disabled="!canReview" @click="trAction(row, 'PUBLISHED')">发布</el-button>
                <el-button v-if="row.status === 'PUBLISHED'" size="small" text type="danger" :disabled="!canReview" @click="trAction(row, 'DEPRECATED')">废弃</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ============ 实例浏览 ============ -->
      <el-tab-pane label="实例浏览" name="instance" lazy>
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <el-select v-model="instanceConcept" filterable style="width:280px" placeholder="选概念（默认 FEE_DETAIL）">
                <el-option v-for="c in conceptStore.concepts" :key="c.code" :label="`${c.code} ${c.name}`" :value="c.code" />
              </el-select>
              <span style="font-size:12px;color:var(--text-3)">行级脱敏：患者姓名打码，业务键保留可下钻</span>
            </div>
          </template>
          <el-button size="small" class="mb12" @click="loadInstances">加载实例</el-button>
          <div v-for="s in instances.sources || []" :key="s.dsCode + s.tableName" class="mb12">
            <el-alert :title="`${s.dsCode} · ${s.tableName}（共 ${s.totalRows} 行）`" type="info" :closable="false" class="mb12" />
            <el-table :data="s.instances" size="small">
              <el-table-column v-for="k in Object.keys(s.instances[0] || {})" :key="k" :prop="k" :label="k" min-width="110" show-overflow-tooltip />
            </el-table>
          </div>
          <el-empty v-if="!instances.sources?.length && instanceLoaded" description="该概念无生效映射或无实例" />
        </el-card>
      </el-tab-pane>

      <!-- ============ 版本与LLM ============ -->
      <el-tab-pane label="版本与LLM" name="release" lazy>
        <el-row :gutter="12">
          <el-col :span="10">
            <el-card shadow="never">
              <template #header>
                <div class="card-header">
                  <b>版本发布</b>
                  <div>
                    <el-tag class="mr4">当前 {{ currentVersion }}</el-tag>
                    <el-button size="small" type="primary" :disabled="!canReview" @click="doPublish">发布新版本</el-button>
                  </div>
                </div>
              </template>
              <el-table :data="releases" size="small">
                <el-table-column prop="version_tag" label="版本" width="80" />
                <el-table-column prop="change_summary" label="变更说明" show-overflow-tooltip />
                <el-table-column prop="element_count" label="元素数" width="80" />
                <el-table-column prop="approved_by" label="批准人" width="90" />
                <el-table-column prop="created_at" label="时间" width="160" />
              </el-table>
            </el-card>
          </el-col>
          <el-col :span="14">
            <el-card shadow="never">
              <template #header><div class="card-header"><b>LLM 调用审计</b></div></template>
              <div style="display:flex;gap:20px" class="mb12">
                <span>总调用 <b>{{ llmS.total }}</b></span><span>成功率 <b>{{ llmS.successRate }}%</b></span>
                <span>平均耗时 <b>{{ llmS.avgLatencyMs }}ms</b></span><span>本体版本 <b>{{ llmS.currentOntologyVersion }}</b></span>
              </div>
              <el-table :data="llmLogs" size="small" max-height="420">
                <el-table-column prop="call_type" label="类型" width="150" />
                <el-table-column prop="provider" label="主备" width="80" />
                <el-table-column prop="model" label="模型" width="150" />
                <el-table-column prop="latency_ms" label="耗时" width="80" />
                <el-table-column label="结果" width="70"><template #default="{ row }"><el-tag size="small" :type="row.success ? 'success' : 'danger'">{{ row.success ? '成功' : '失败' }}</el-tag></template></el-table-column>
                <el-table-column prop="created_at" label="时间" width="160" />
              </el-table>
            </el-card>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- ============ 公理 ============ -->
      <el-tab-pane label="公理" name="axiom" lazy>
        <el-card shadow="never">
          <template #header><div class="card-header"><b>SPO 公理（自由文本，OWL 导入溯源）</b><el-button size="small" :disabled="isViewer" @click="axiomDlg = true">新增公理</el-button></div></template>
          <el-table :data="axioms" size="small">
            <el-table-column prop="axiom_code" label="编码" width="120" class-name="mono" />
            <el-table-column prop="subject" label="主语" width="160" />
            <el-table-column label="谓词" width="110"><template #default="{ row }"><el-tag size="small" :type="predicateTag(row.axiom_type)">{{ row.predicate }}（{{ row.axiom_type }}）</el-tag></template></el-table-column>
            <el-table-column prop="object" label="宾语" width="160" />
            <el-table-column prop="description" label="说明" show-overflow-tooltip />
            <el-table-column label="" width="70"><template #default="{ row }"><el-button size="small" text type="danger" :disabled="isViewer" @click="delAxiom(row)">删除</el-button></template></el-table-column>
          </el-table>
        </el-card>
        <el-dialog v-model="axiomDlg" title="新增公理" width="460px">
          <el-form label-width="60px">
            <el-form-item label="主语"><el-input v-model="axiomForm.subject" /></el-form-item>
            <el-form-item label="谓词"><el-input v-model="axiomForm.predicate" /></el-form-item>
            <el-form-item label="宾语"><el-input v-model="axiomForm.object" /></el-form-item>
            <el-form-item label="类型"><el-select v-model="axiomForm.axiomType"><el-option v-for="t in ['依赖', '互斥', '支撑', '因果', '继承', '存在性', '约束']" :key="t" :value="t" /></el-select></el-form-item>
            <el-form-item label="说明"><el-input v-model="axiomForm.description" type="textarea" /></el-form-item>
          </el-form>
          <template #footer><el-button @click="axiomDlg = false">取消</el-button><el-button type="primary" @click="saveAxiom">保存</el-button></template>
        </el-dialog>
      </el-tab-pane>
    </el-tabs>

    <!-- 扩展提案抽屉（本体增长回路） -->
    <el-drawer v-model="proposalDrawer" size="700px" title="扩展提案（词表外说法处置）">
      <el-tabs v-model="missTab">
        <el-tab-pane label="待处理" name="pending">
          <div v-for="m in pendingMisses" :key="m.id" class="miss-card">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div><b>{{ m.term }}</b>
                <el-tag size="small" class="mr4" :type="m.kind === 'CONCEPT' ? 'primary' : m.kind === 'QUESTION' ? 'warning' : 'info'">{{ m.kind }}</el-tag>
                <el-tag size="small" type="info">{{ m.source }}</el-tag>
                <el-tag v-if="m.count >= 3" size="small" type="danger">高热 {{ m.count }}</el-tag>
              </div>
              <div class="miss-count">×{{ m.count }}</div>
            </div>
            <div style="margin:8px 0;font-size:12px;color:var(--text-3)">最近出现：{{ m.last_seen }}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <el-button size="small" type="primary" :loading="classifying === m.id" @click="classify(m.id)">AI 归类</el-button>
              <el-button size="small" :disabled="isViewer" @click="openAdopt(m)">采纳为新概念</el-button>
              <el-button size="small" :disabled="isViewer" @click="adoptAsTerm(m)">挂为术语</el-button>
              <el-button size="small" :disabled="isViewer" @click="dismissMiss(m)">忽略</el-button>
            </div>
            <div v-if="suggestions[m.id]" class="suggestion">
              <b>{{ suggestions[m.id].suggestion.action === 'ATTACH_TERM' ? `挂靠 ${suggestions[m.id].suggestion.targetConceptCode}` : `建议新概念 ${suggestions[m.id].suggestion.code}` }}</b>
              <span v-if="suggestions[m.id].degraded" class="mono" style="color:var(--warning)">（LLM 不可用，规则降级）</span>
              <div>{{ suggestions[m.id].suggestion.reason }}</div>
            </div>
          </div>
          <el-empty v-if="!pendingMisses.length" description="暂无待处理缺口" />
        </el-tab-pane>
        <el-tab-pane label="已忽略" name="dismissed">
          <el-table :data="dismissedMisses" size="small">
            <el-table-column prop="term" label="说法" /><el-table-column prop="count" label="次数" width="80" />
            <el-table-column prop="dismiss_reason" label="理由" /><el-table-column label="" width="90">
              <template #default="{ row }"><el-button size="small" text :disabled="isViewer" @click="missAction(row.id, 'undismiss').then(loadMisses)">恢复</el-button></template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="AI 提案队列" name="proposal">
          <el-button size="small" type="primary" class="mb12" :disabled="isViewer" :loading="proposalRunning" @click="genProposals">生成提案（扫热度前 10）</el-button>
          <el-table :data="proposals" size="small">
            <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag size="small" :type="{ PENDING: 'warning', ADOPTED: 'success', REJECTED: 'info' }[row.status]">{{ row.status }}</el-tag></template></el-table-column>
            <el-table-column prop="term" label="代表说法" />
            <el-table-column prop="signal_count" label="热度" width="70" />
            <el-table-column label="AI 判定" min-width="180">
              <template #default="{ row }">
                {{ row.action === 'NEW_CONCEPT' ? '新建概念' : '挂靠术语' }} {{ row.target_concept_code || '' }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <template v-if="row.status === 'PENDING'">
                  <el-button size="small" text type="success" :disabled="isViewer" @click="adoptProposal(row.id).then(refreshProposal)">采纳</el-button>
                  <el-button size="small" text type="danger" :disabled="isViewer" @click="rejectProposal(row.id, '人工驳回').then(refreshProposal)">驳回</el-button>
                </template>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-drawer>

    <!-- 采纳弹窗 -->
    <el-dialog v-model="adoptDlg" title="采纳为新概念（DRAFT）" width="480px">
      <el-form label-width="70px">
        <el-form-item label="编码"><el-input v-model="adoptForm.code" :class="{ 'code-taken': codeTaken }" /><span v-if="codeTaken" style="color:var(--danger);font-size:12px">编码已存在</span></el-form-item>
        <el-form-item label="名称"><el-input v-model="adoptForm.name" /></el-form-item>
        <el-form-item label="业务域"><el-select v-model="adoptForm.domainCode" style="width:100%"><el-option v-for="d in domains" :key="d.code" :label="d.code" :value="d.code" /></el-select></el-form-item>
        <el-form-item label="定义"><el-input v-model="adoptForm.definition" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="adoptDlg = false">取消</el-button><el-button type="primary" @click="doAdopt">采纳</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { UploadFilled } from '@element-plus/icons-vue';
import {
  listDomains, createDomain, listConcepts, conceptDetail, createConcept, updateConcept, deleteConcept, transitionConcept,
  addAttribute, deleteAttribute, addRelation, updateRelation, deleteRelation, listParents, addParent, deleteParent, setPrimaryParent,
  listRules, createRule, transitionRule, listActions, transitionAction, listAxioms, createAxiom, deleteAxiom,
  listDisjoint, addDisjoint, deleteDisjoint, checkOntology, relationClosure, listMisses, missAction, classifyMiss,
  listProposals, runProposal, adoptProposal, rejectProposal, owlPreview, owlExecute,
  listInstances, releaseList, releaseCurrent, publishRelease, llmLogList, llmStats, createTerm,
  architectureOverview,
} from '../../api';
import { useUserStore } from '../../store/user';
import { useConceptStore } from '../../store/user';
import GraphCanvas from '../../components/GraphCanvas.vue';

const route = useRoute(); const router = useRouter();
const userStore = useUserStore();
const conceptStore = useConceptStore();
const isViewer = computed(() => userStore.isViewer);
const canReview = computed(() => userStore.canReview);

const tab = ref('concept');
const domains = ref([]);
const concepts = ref([]);
const curDomain = ref('');
const page = ref(1);
const detailDrawer = ref(false);
const detail = ref(null);
const innerTab = ref('attr');
const missCount = ref(0);

const statusText = (s) => ({ DRAFT: '草稿', REVIEW: '评审中', PUBLISHED: '已发布', DEPRECATED: '已废弃' }[s] || s);
const statusTag = (s) => ({ DRAFT: 'info', REVIEW: 'warning', PUBLISHED: 'success', DEPRECATED: 'danger' }[s] || 'info');
const stepActive = (s) => ({ DRAFT: 0, REVIEW: 1, PUBLISHED: 2, DEPRECATED: 4 }[s] ?? 0);
const axiomFlags = (r) => {
  const out = [];
  if (Number(r.is_symmetric)) out.push('对称');
  if (Number(r.is_transitive)) out.push('传递');
  if (Number(r.is_functional)) out.push('函数');
  if (Number(r.is_inverse_functional)) out.push('逆函数');
  if (Number(r.is_asymmetric)) out.push('反对称');
  return out;
};
const pretty = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s || ''; } };

const domainTree = computed(() => [{ name: '全部业务域', children: domains.value }, ...[]]);
const filteredConcepts = computed(() => curDomain.value ? concepts.value.filter(c => c.domain_code === curDomain.value) : concepts.value);
const pagedConcepts = computed(() => filteredConcepts.value.slice((page.value - 1) * 20, page.value * 20));

async function loadAll() {
  domains.value = await listDomains();
  concepts.value = await listConcepts();
  conceptStore.concepts = concepts.value;
  conceptStore.loaded = true;
}
function onDomainClick(d) { curDomain.value = d.children ? '' : d.code; page.value = 1; }

async function openDetail(row) {
  detail.value = await conceptDetail(row.code);
  detailDrawer.value = true;
  innerTab.value = 'attr';
  loadGraph();
}
const graphNodes = computed(() => {
  if (!detail.value) return [];
  const c = detail.value.concept;
  const nodes = [{ id: c.code, name: `${c.name}`, symbolSize: 34, itemStyle: { color: '#2d8a7e' } }];
  const seen = new Set([c.code]);
  for (const r of detail.value.relations) {
    for (const x of [r.from_concept, r.to_concept]) {
      if (!seen.has(x)) { seen.add(x); nodes.push({ id: x, name: x, symbolSize: 22, itemStyle: { color: '#67c23a' } }); }
    }
  }
  return nodes;
});
const graphEdges = computed(() => (detail.value?.relations || []).map(r => ({
  source: r.from_concept, target: r.to_concept,
  lineStyle: { color: '#67c23a', type: Number(r.is_transitive) ? 'dashed' : 'solid' },
  label: { show: true, formatter: r.relation_name, fontSize: 10 },
})));
const transitiveRels = computed(() => [...new Set((detail.value?.relations || []).filter(r => Number(r.is_transitive)).map(r => r.relation_name))]);
const closureRel = ref(''); const closureRows = ref([]);
const closureGroups = computed(() => {
  const g = {};
  for (const r of closureRows.value) (g[r.depth] = g[r.depth] || []).push(r.to_concept);
  return Object.entries(g).map(([depth, items]) => ({ depth, items }));
});
async function loadClosure() {
  if (!closureRel.value) return;
  closureRows.value = await relationClosure({ relation: closureRel.value, concept: detail.value.concept.code });
}

// ---- 全局概念图谱 ----
const graphTabLoaded = ref(false);
const graphDomain = ref('');
const graphKeyword = ref('');
const graphAll = ref({ nodes: [], edges: [] });
const DOMAIN_COLORS = ['#409eff', '#67c23a', '#e6a23c', '#722ed1', '#f56c6c', '#13c2c2', '#2d8a7e', '#d48265', '#9a60b4', '#ea7ccc'];
const domainColor = (code) => DOMAIN_COLORS[Math.max(0, domains.value.findIndex(d => d.code === code)) % DOMAIN_COLORS.length];
const kgNodes = computed(() => graphAll.value.nodes
  .filter(n => n.type === 'CONCEPT')
  .filter(n => !graphDomain.value || n.domainCode === graphDomain.value)
  .filter(n => !graphKeyword.value || (n.name || '').includes(graphKeyword.value) || (n.code || '').includes(graphKeyword.value))
  .map(n => ({
    id: n.id, name: n.name || n.code,
    symbolSize: 16 + Math.min(10, n.stats?.mappingCount || 0),
    itemStyle: { color: domainColor(n.domainCode) },
    raw: n,
  })));
const kgEdges = computed(() => {
  const ids = new Set(kgNodes.value.map(n => n.id));
  return graphAll.value.edges
    .filter(e => e.kind === 'RELATION' && ids.has(e.from) && ids.has(e.to))
    .map(e => ({
      source: e.from, target: e.to,
      lineStyle: { color: '#67c23a', type: e.axioms?.includes('transitive') ? 'dashed' : 'solid' },
      label: { show: true, formatter: e.names, fontSize: 9 },
    }));
});
function kgTip(p) {
  const r = p.data.raw;
  return `${r.code}（${r.name}）<br/>域：${r.domainCode}｜状态：${r.status}<br/>生效映射表：${r.stats?.mappingCount || 0}`;
}
watch(tab, async (t) => { if (t === 'graph' && !graphTabLoaded.value) { graphAll.value = await architectureOverview(); graphTabLoaded.value = true; } });

// 弹窗表单
const conceptDlg = ref(false); const editMode = ref(false);
const conceptForm = ref({});
function openConcept(c) {
  editMode.value = !!c;
  conceptForm.value = c ? { code: c.code, name: c.name, domainCode: c.domain_code, definition: c.definition, owner: c.owner, iri: c.iri } : { domainCode: curDomain.value || 'CLINICAL' };
  conceptDlg.value = true;
}
async function saveConcept() {
  if (editMode.value) await updateConcept(conceptForm.value);
  else await createConcept(conceptForm.value);
  conceptDlg.value = false;
  ElMessage.success('已保存');
  await loadAll();
  if (detail.value) await openDetail({ code: detail.value.concept.code });
}
async function delConcept() {
  await ElMessageBox.confirm('确认删除该草稿概念？', '删除');
  await deleteConcept(detail.value.concept.code);
  detailDrawer.value = false;
  await loadAll();
}
async function transition(target) {
  try {
    await transitionConcept(detail.value.concept.code, target);
    ElMessage.success(`已${{ REVIEW: '提交评审', PUBLISHED: '发布', DRAFT: '退回草稿', DEPRECATED: '废弃' }[target]}`);
    await openDetail({ code: detail.value.concept.code });
    await loadAll();
  } catch { /* 拦截器已提示 */ }
}
const domainDlg = ref(false); const domainForm = ref({});
async function saveDomain() { await createDomain(domainForm.value); domainDlg.value = false; await loadAll(); }
const attrDlg = ref(false); const attrForm = ref({ dataType: 'STRING' });
async function saveAttr() {
  await addAttribute({ ...attrForm.value, conceptCode: detail.value.concept.code });
  attrDlg.value = false; attrForm.value = { dataType: 'STRING' };
  await openDetail({ code: detail.value.concept.code });
}
async function delAttr(row) { await deleteAttribute(row.id); await openDetail({ code: detail.value.concept.code }); }
const relDlg = ref(false); const relForm = ref({});
function openRelDlg(r) {
  relForm.value = r ? {
    id: r.id, fromConcept: r.from_concept, toConcept: r.to_concept, relationName: r.relation_name, description: r.description,
    isSymmetric: String(r.is_symmetric || 0), isTransitive: String(r.is_transitive || 0), isFunctional: String(r.is_functional || 0),
    isInverseFunctional: String(r.is_inverse_functional || 0), isAsymmetric: String(r.is_asymmetric || 0), inverseOf: r.inverse_of || '',
  } : { fromConcept: detail.value.concept.code, isSymmetric: '0', isTransitive: '0', isFunctional: '0', isInverseFunctional: '0', isAsymmetric: '0' };
  relDlg.value = true;
}
async function saveRel() {
  if (relForm.value.id) await updateRelation(relForm.value.id, relForm.value);
  else await addRelation(relForm.value);
  relDlg.value = false;
  await openDetail({ code: detail.value.concept.code });
}
async function delRel(row) { await deleteRelation(row.id); await openDetail({ code: detail.value.concept.code }); }
const parentDlg = ref(false); const parentForm = ref({});
const parentCandidates = computed(() => conceptStore.concepts.filter(c => c.code !== detail.value?.concept?.code && !detail.value?.parents?.some(p => p.parent_code === c.code)));
async function saveParent() {
  await addParent(detail.value.concept.code, parentForm.value);
  parentDlg.value = false;
  await openDetail({ code: detail.value.concept.code });
}
async function setPrimary(row) { await setPrimaryParent(detail.value.concept.code, row.parent_code); await openDetail({ code: detail.value.concept.code }); }
async function delParent(row) { await deleteParent(detail.value.concept.code, row.parent_code); await openDetail({ code: detail.value.concept.code }); }
const disjointDlg = ref(false); const disjointForm = ref({});
async function saveDisjoint() {
  await addDisjoint({ conceptACode: disjointForm.value.a, conceptBCode: disjointForm.value.b, definition: disjointForm.value.definition });
  disjointDlg.value = false;
  await openDetail({ code: detail.value.concept.code });
}
async function delDisjoint(row) { await deleteDisjoint(row.id); await openDetail({ code: detail.value.concept.code }); }

// 规则/动作/公理
const rules = ref([]); const actions = ref([]); const axioms = ref([]);
const ruleDlg = ref(false); const ruleForm = ref({ engineQC: false });
const ruleExprDlg = ref(null);
const axiomDlg = ref(false); const axiomForm = ref({});
function openRule() { ruleForm.value = { engineQC: false, severity: '中' }; ruleDlg.value = true; }
async function saveRule() {
  const f = ruleForm.value;
  await createRule({
    ruleCode: f.ruleCode, name: f.name, conceptCode: f.conceptCode, ruleType: '校验',
    expression: f.engineQC ? '(QC 表达式，见 expr_json)' : f.expression,
    severity: f.severity, engine: f.engineQC ? 'QC' : null, exprJson: f.engineQC ? f.exprJson : null,
  });
  ruleDlg.value = false; rules.value = await listRules();
}
async function trRule(row, target) { await transitionRule(row.rule_code, target); rules.value = await listRules(); }
async function trAction(row, target) { await transitionAction(row.action_code, target); actions.value = await listActions(); }
async function saveAxiom() { await createAxiom(axiomForm.value); axiomDlg.value = false; axioms.value = await listAxioms(); }
async function delAxiom(row) { await deleteAxiom(row.id); axioms.value = await listAxioms(); }

// 实例
const instanceConcept = ref('FEE_DETAIL'); const instances = ref({}); const instanceLoaded = ref(false);
async function loadInstances() { instances.value = await listInstances(instanceConcept.value, { pageNum: 1, pageSize: 10 }); instanceLoaded.value = true; }

// 版本/LLM
const releases = ref([]); const currentVersion = ref('未发布'); const llmLogs = ref([]); const llmS = ref({});
async function doPublish() {
  const check = await checkOntology();
  if (check.blockerCount > 0) { ElMessage.error(`存在 ${check.blockerCount} 个 BLOCKER，拒绝发布`); return; }
  if (check.defects.length) {
    await ElMessageBox.confirm(`存在 ${check.warnCount} 个 WARN 缺陷（${check.defects.map(d => d.type).join('、')}），仍要发布？`, '发布门禁', { type: 'warning' });
    await publishRelease({ force: 'true', changeSummary: '人工确认发布' });
  } else {
    const { changeSummary } = await ElMessageBox.prompt('变更说明', '发布新版本', { inputValue: '常规发布' });
    await publishRelease({ changeSummary });
  }
  ElMessage.success('已发布');
  releases.value = await releaseList(); currentVersion.value = (await releaseCurrent()).version;
}

// OWL 导入
const owlDlg = ref(false); const owlFile = ref(null); const owlPlan = ref(null); const owlLoading = ref(false);
async function doOwlPreview() {
  owlLoading.value = true;
  try { owlPlan.value = await owlPreview(await owlFile.value.text(), owlFile.value.name); }
  finally { owlLoading.value = false; }
}
async function doOwlExecute() {
  await owlExecute(await owlFile.value.text(), owlFile.value.name);
  owlDlg.value = false; owlPlan.value = null;
  ElMessage.success('导入完成（DRAFT，待评审发布）');
  await loadAll();
}

// 缺口/提案
const proposalDrawer = ref(false); const misses = ref([]); const suggestions = ref({}); const classifying = ref(0);
const missTab = ref('pending'); const proposals = ref([]); const proposalRunning = ref(false);
const adoptDlg = ref(false); const adoptForm = ref({}); const adoptMissId = ref(null); const codeTaken = ref(false);
const pendingMisses = computed(() => misses.value.filter(m => !m.dismissed && !m.revoked && (!m.adopted_concept_code || m.revoked)));
const dismissedMisses = computed(() => misses.value.filter(m => m.dismissed));
async function loadMisses() {
  const r = await listMisses();
  misses.value = r.list; missCount.value = r.pendingCount;
  proposals.value = await listProposals('ALL');
}
function openAdopt(m) {
  adoptMissId.value = m.id;
  const s = suggestions.value[m.id]?.suggestion;
  adoptForm.value = s && s.action === 'NEW_CONCEPT' ? { code: s.code, name: s.name, domainCode: s.domainCode || 'CLINICAL', definition: s.definition } : { domainCode: 'CLINICAL' };
  adoptDlg.value = true;
}
async function doAdopt() {
  await missAction(adoptMissId.value, 'adopt', adoptForm.value);
  adoptDlg.value = false; ElMessage.success('已采纳为 DRAFT 概念');
  await loadMisses(); await loadAll();
}
async function adoptAsTerm(m) {
  const { value } = await ElMessageBox.prompt('挂靠到概念编码', '挂为术语', { inputValue: 'PATIENT' });
  await createTerm({ term: m.term, conceptCode: value, sourceProduct: 'ONTOLOGY_MISS' });
  await missAction(m.id, 'adopt-as-term', { conceptCode: value });
  ElMessage.success('已挂为术语'); await loadMisses();
}
async function dismissMiss(m) {
  const { value } = await ElMessageBox.prompt('忽略理由（必填）', '忽略', { inputValue: '' });
  await missAction(m.id, 'dismiss', { reason: value }); await loadMisses();
}
async function classify(id) {
  classifying.value = id;
  try { suggestions.value[id] = await classifyMiss(id); }
  finally { classifying.value = 0; }
}
async function refreshProposal() { proposals.value = await listProposals('ALL'); await loadMisses(); }
async function genProposals() {
  proposalRunning.value = true;
  try { const r = await runProposal(); ElMessage.success(`扫描 ${r.scanned} 条，生成 ${r.generated} 个提案，LLM 失败 ${r.llmFailed}`); await refreshProposal(); }
  finally { proposalRunning.value = false; }
}
watch(codeTaken, () => {});

onMounted(async () => {
  await loadAll();
  rules.value = await listRules();
  actions.value = await listActions();
  axioms.value = await listAxioms();
  releases.value = await releaseList();
  currentVersion.value = (await releaseCurrent()).version;
  llmS.value = await llmStats();
  llmLogs.value = (await llmLogList({ pageSize: 20 })).list;
  try { missCount.value = (await listMisses()).pendingCount; } catch { /* */ }
  if (route.query.tab) tab.value = route.query.tab;
  if (route.query.concept) openDetail({ code: route.query.concept });
  if (route.query.domain) curDomain.value = route.query.domain;
});
</script>

<style scoped>
.domain-active { color: var(--primary); font-weight: 600; }
.miss-card { border: 1px solid #eef2f5; border-radius: 10px; padding: 12px; margin-bottom: 10px; }
.miss-count { font-size: 20px; font-weight: 700; color: var(--warning); }
.suggestion { margin-top: 8px; background: #f8fafc; border-radius: 8px; padding: 8px 10px; font-size: 12px; }
.code-taken :deep(.el-input__inner) { color: var(--danger); }
.mr4 { margin-right: 4px; } .mr8 { margin-right: 8px; } .mb4 { margin-bottom: 4px; } .mb12 { margin-bottom: 12px; }
</style>
