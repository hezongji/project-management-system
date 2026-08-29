/**
 * 组件共用的轻量 axios 入口 —— 复用 services/api.ts 的实例
 * （token 拦截器 + baseURL /api），避免各组件重复建实例。
 */
export { api } from './api'
