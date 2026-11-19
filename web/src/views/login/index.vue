<template>
  <div class="login-bg">
    <el-card class="login-card">
      <div class="brand">
        <div class="bm-avatar" style="width:44px;height:44px;border-radius:12px;font-size:18px;display:flex;align-items:center;justify-content:center;">Bm</div>
        <div>
          <div style="font-weight:700;font-size:18px">BeModel 医疗本体平台</div>
          <div style="font-size:12px;color:var(--text-3)">物理自治 · 逻辑统一 —— 复现版</div>
        </div>
      </div>
      <el-form @submit.prevent>
        <el-form-item>
          <el-input v-model="username" placeholder="用户名" @keyup.enter="doLogin" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="password" type="password" show-password placeholder="密码" @keyup.enter="doLogin" />
        </el-form-item>
        <el-button type="primary" style="width:100%" :loading="loading" @click="doLogin">登 录</el-button>
      </el-form>
      <div class="demo-accounts">
        演示账号与角色权限见项目 README「演示账号」表（评审材料同）。
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { login } from '../../api';
import { useUserStore } from '../../store/user';

const router = useRouter();
const route = useRoute();
const userStore = useUserStore();
const username = ref('');
const password = ref('');
const loading = ref(false);

async function doLogin() {
  loading.value = true;
  try {
    const data = await login({ username: username.value, password: password.value });
    userStore.loginSuccess(data);
    router.push(route.query.redirect || '/');
  } finally { loading.value = false; }
}
</script>

<style scoped>
.login-bg { height: 100%; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #16222f 0%, #1d3a47 55%, #226b62 100%); }
.login-card { width: 400px; border-radius: 16px; }
.brand { display: flex; gap: 12px; align-items: center; margin-bottom: 20px; }
.demo-accounts { margin-top: 16px; font-size: 11px; color: var(--text-3); line-height: 1.8; }
</style>
