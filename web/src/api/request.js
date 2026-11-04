import axios from 'axios';
import { ElMessage } from 'element-plus';

const instance = axios.create({ baseURL: '/api', timeout: 180000 });
instance.interceptors.request.use((cfg) => {
  const token = localStorage.getItem('bemodel_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});
instance.interceptors.response.use(
  (resp) => {
    const body = resp.data;
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code === 0) return body.data;
      ElMessage.error(body.msg || '请求失败');
      return Promise.reject(new Error(body.msg));
    }
    return body;
  },
  (err) => {
    const status = err.response?.status;
    const body = err.response?.data;
    if (status === 401) {
      localStorage.removeItem('bemodel_token');
      localStorage.removeItem('bemodel_user');
      if (!location.pathname.startsWith('/login')) location.href = '/login?redirect=' + encodeURIComponent(location.pathname + location.search);
    } else if (status === 403) {
      ElMessage.error('权限不足：需要编辑或管理员角色');
    } else {
      ElMessage.error(body?.msg || err.message || '网络错误');
    }
    return Promise.reject(err);
  },
);
export default instance;
