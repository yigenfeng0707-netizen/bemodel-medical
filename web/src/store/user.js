import { defineStore } from 'pinia';

export const useUserStore = defineStore('user', {
  state: () => ({
    token: localStorage.getItem('bemodel_token') || '',
    user: JSON.parse(localStorage.getItem('bemodel_user') || 'null'),
  }),
  getters: {
    isLoggedIn: (s) => !!s.token,
    isViewer: (s) => s.user?.role === 'VIEWER',
    canReview: (s) => ['REVIEWER', 'ADMIN'].includes(s.user?.role),
    roleText: (s) => ({ ADMIN: '管理员', EDITOR: '建模员', REVIEWER: '评审员', VIEWER: '只读' }[s.user?.role] || s.user?.role),
    roleTagType: (s) => ({ ADMIN: 'danger', EDITOR: 'success', REVIEWER: 'warning', VIEWER: 'info' }[s.user?.role] || 'info'),
  },
  actions: {
    loginSuccess(data) {
      this.token = data.token;
      this.user = { username: data.username, displayName: data.displayName, role: data.role };
      localStorage.setItem('bemodel_token', data.token);
      localStorage.setItem('bemodel_user', JSON.stringify(this.user));
    },
    async logout() {
      try {
        if (this.token) {
          const { logout } = await import('../api');
          await logout();
        }
      } catch { /* 服务端吊销失败不阻塞本地登出 */ } finally {
        this.token = '';
        this.user = null;
        localStorage.removeItem('bemodel_token');
        localStorage.removeItem('bemodel_user');
      }
    },
  },
});

export const useConceptStore = defineStore('concept', {
  state: () => ({ concepts: [], loaded: false }),
  actions: {
    async fetchAll(force = false) {
      if (this.loaded && !force) return this.concepts;
      const { listConcepts } = await import('../api');
      this.concepts = await listConcepts();
      this.loaded = true;
      return this.concepts;
    },
  },
});
