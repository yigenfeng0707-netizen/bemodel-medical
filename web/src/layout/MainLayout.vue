<template>
  <el-container style="height: 100vh">
    <el-aside width="240px" class="sidebar">
      <div class="logo">
        <div class="logo-badge">Bm</div>
        <div>
          <div class="logo-title">BeModel</div>
          <div class="logo-sub">医疗本体平台</div>
        </div>
      </div>
      <el-menu :default-active="$route.path" router background-color="#1a2332" text-color="#8fa3b8" active-text-color="#ffffff" class="menu">
        <el-menu-item index="/architecture"><el-icon><Platform /></el-icon>架构全貌</el-menu-item>
        <div class="menu-group">核心功能</div>
        <el-menu-item index="/ontology"><el-icon><Collection /></el-icon>本体管理</el-menu-item>
        <el-menu-item index="/datasource"><el-icon><Connection /></el-icon>数据源绑定</el-menu-item>
        <el-menu-item index="/glossary"><el-icon><Notebook /></el-icon>统一口径</el-menu-item>
        <el-menu-item index="/knowledge"><el-icon><Reading /></el-icon>知识库</el-menu-item>
        <el-menu-item index="/ask"><el-icon><ChatDotRound /></el-icon>智能问数</el-menu-item>
        <el-menu-item index="/link"><el-icon><Share /></el-icon>链路追溯</el-menu-item>
        <el-menu-item index="/trace"><el-icon><Connection /></el-icon>证据链</el-menu-item>
        <el-menu-item index="/gov"><el-icon><Stamp /></el-icon>数据治理</el-menu-item>
        <div class="menu-group">应用场景</div>
        <el-menu-item index="/flow"><el-icon><Tickets /></el-icon>医嘱闭环</el-menu-item>
        <el-menu-item index="/clinical"><el-icon><FirstAidKit /></el-icon>临床决策</el-menu-item>
        <el-menu-item index="/cs"><el-icon><Service /></el-icon>AI客服</el-menu-item>
        <el-menu-item index="/value"><el-icon><DataAnalysis /></el-icon>价值实证</el-menu-item>
        <el-menu-item index="/lab"><el-icon><DataAnalysis /></el-icon>AI查询比对</el-menu-item>
        <div class="menu-group">本体演化</div>
        <el-menu-item index="/evolve">
          <el-icon><Opportunity /></el-icon>概念缺口
          <el-badge v-if="missCount" :value="missCount" class="menu-badge" />
        </el-menu-item>
        <el-menu-item index="/drift"><el-icon><Aim /></el-icon>语义漂移</el-menu-item>
      </el-menu>
      <div class="sidebar-footer">v0.1.0 · 复现版<br />© 2026 BeModel Team</div>
    </el-aside>
    <el-container>
      <el-header height="60px" class="topbar">
        <div>
          <span class="page-title">{{ $route.meta.title }}</span>
          <span class="crumb">BeModel / {{ $route.meta.title }}</span>
          <span v-if="$route.meta.subtitle" class="subtitle">{{ $route.meta.subtitle }}</span>
        </div>
        <div class="topbar-right">
          <span class="status-wrap"><span class="status-dot" />系统运行正常</span>
          <el-badge :value="unread || ''" :hidden="!unread" class="bell">
            <el-button :icon="Bell" text @click="noticeOpen = true; loadNotices()" />
          </el-badge>
          <el-tag v-if="llmHealth" size="small" :type="llmHealth[0]?.healthy ? 'success' : 'info'" effect="plain">
            AI: {{ llmHealth[0]?.model }}{{ llmHealth.length > 1 ? (llmHealth[1]?.healthy ? '（备正常）' : '（备异常）') : '' }}
          </el-tag>
          <el-dropdown @command="onUserCmd">
            <span class="user-chip">
              <span class="bm-avatar">{{ (userStore.user?.displayName || 'U').slice(0, 1) }}</span>
              {{ userStore.user?.displayName }}
              <el-tag size="small" :type="userStore.roleTagType">{{ userStore.roleText }}</el-tag>
            </span>
            <template #dropdown><el-dropdown-menu><el-dropdown-item command="logout">退出登录</el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
        </div>
      </el-header>
      <el-main class="main"><router-view /></el-main>
    </el-container>
  </el-container>

  <el-drawer v-model="noticeOpen" title="巡检告警" size="480px">
    <div class="mb12">
      <el-button size="small" type="primary" @click="runInspectNow">立即巡检</el-button>
      <el-button size="small" @click="readAll">全部已读</el-button>
    </div>
    <el-empty v-if="!notices.length" description="暂无告警" />
    <div v-for="n in notices" :key="n.id" class="notice-item" @click="readOne(n)">
      <div class="notice-title">
        <el-tag v-if="n.metric_code?.startsWith('RECON:')" size="small" type="warning">对账差异</el-tag>
        <el-tag v-else size="small" type="danger">指标告警</el-tag>
        {{ n.metric_name || n.metric_code }}
        <el-tag size="small" :type="n.status === '未读' ? 'danger' : 'info'">{{ n.status }}</el-tag>
      </div>
      <div class="notice-msg">{{ n.message }}</div>
      <div class="notice-time">{{ n.created_at }}</div>
    </div>
  </el-drawer>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Platform, Collection, Connection, Notebook, Reading, ChatDotRound, Share, Stamp, Tickets, FirstAidKit, Service, DataAnalysis, Opportunity, Aim, Bell } from '@element-plus/icons-vue';
import { useUserStore } from '../store/user';
import { noticeUnreadCount, noticeList, noticeRead, noticeReadAll, inspectRun, llmRoutes, listMisses } from '../api';

const router = useRouter();
const userStore = useUserStore();
const unread = ref(0);
const missCount = ref(0);
const llmHealth = ref(null);
const noticeOpen = ref(false);
const notices = ref([]);
let timer = null;

async function refresh() {
  try {
    const u = await noticeUnreadCount();
    unread.value = u.count;
    const m = await listMisses();
    missCount.value = m.pendingCount;
    llmHealth.value = await llmRoutes();
  } catch { /* silent */ }
}
async function loadNotices() {
  notices.value = (await noticeList({ pageSize: 50 })).list;
}
async function readOne(n) { if (n.status === '未读') { await noticeRead(n.id); await loadNotices(); await refresh(); } }
async function readAll() { await noticeReadAll(); await loadNotices(); await refresh(); }
async function runInspectNow() { const r = await inspectRun(); ElMessage.success(`巡检完成：评估 ${r.evaluated} 项，告警 ${r.alarmed} 项，新增通知 ${r.noticesCreated}`); await loadNotices(); await refresh(); }
async function onUserCmd(cmd) { if (cmd === 'logout') { await userStore.logout(); router.push('/login'); } }

onMounted(() => { refresh(); timer = setInterval(refresh, 60000); });
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.sidebar { background: var(--sidebar-bg); display: flex; flex-direction: column; }
.logo { display: flex; align-items: center; gap: 10px; padding: 18px 16px 14px; color: #fff; }
.logo-badge { width: 36px; height: 36px; border-radius: 10px; background: linear-gradient(135deg, #2d8a7e, #3ba396); display: flex; align-items: center; justify-content: center; font-weight: 700; }
.logo-title { font-weight: 700; font-size: 15px; }
.logo-sub { font-size: 11px; color: #8fa3b8; }
.menu { border-right: none; flex: 1; overflow-y: auto; }
.menu-group { padding: 12px 20px 4px; font-size: 11px; color: #5a6b7d; letter-spacing: 2px; }
.menu-badge { margin-left: 8px; }
.sidebar-footer { padding: 12px 16px; font-size: 11px; color: #5a6b7d; line-height: 1.8; }
.topbar { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #eef2f5; }
.crumb { margin-left: 12px; font-size: 12px; color: var(--text-3); }
.subtitle { margin-left: 12px; font-size: 12px; color: var(--text-3); }
.topbar-right { display: flex; align-items: center; gap: 14px; }
.status-wrap { font-size: 12px; color: var(--text-2); display: flex; align-items: center; }
.user-chip { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; }
.bm-avatar { width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; }
.notice-item { padding: 10px 12px; border: 1px solid #eef2f5; border-radius: 8px; margin-bottom: 8px; cursor: pointer; }
.notice-title { font-size: 13px; font-weight: 600; display: flex; gap: 6px; align-items: center; }
.notice-msg { font-size: 12px; color: var(--text-2); margin: 6px 0; }
.notice-time { font-size: 11px; color: var(--text-3); }
.main { background: #f6f8fa; padding: 20px 24px; overflow-y: auto; }
</style>
