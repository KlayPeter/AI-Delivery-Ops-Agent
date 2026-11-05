import axios from "axios";
import { rememberRunInput, setInputCapture } from './runInputs.mjs';

const API_BASE = ((import.meta as any).env?.VITE_API_BASE || `http://${window.location.hostname}:8090/api`).replace(/\/$/, "");

const client = axios.create({
  baseURL: API_BASE,
  timeout: 120000,
  headers: {
    "Content-Type": "application/json",
  },
});

interface ApiError extends Error {
  status?: number;
  payload?: any;
}

const normalizeError = (error: any): ApiError => {
  const payload = error.response?.data;
  const serverMessage = payload?.message || payload?.error;
  const message =
    serverMessage ||
    (error.code === "ECONNABORTED" ? "请求超时，请确认后端服务是否正常" : error.message) ||
    "请求失败";

  const normalized = new Error(message) as ApiError;
  normalized.status = error.response?.status;
  normalized.payload = payload;
  return normalized;
};

const request = async (promise: Promise<any>) => {
  try {
    const response = await promise;
    return response.data;
  } catch (error) {
    throw normalizeError(error);
  }
};

const safeArray = (value: any) => (Array.isArray(value) ? value : []);

export const api = {
  fetchWorkspace: async () => {
    const result = await request(client.get('/workspace/state'));
    setInputCapture(result.plugins?.some((plugin: { id: string }) => plugin.id === 'personal.recipes') === true);
    return result;
  },
  fetchRecipes: () => request(client.get('/recipes')),
  fetchRecipe: (id: string) => request(client.get(`/recipes/${encodeURIComponent(id)}`)),
  saveRecipe: (input: Record<string, unknown>) => request(client.post('/recipes', input)),
  launchRecipe: (id: string, input: Record<string, unknown>, triggerId: string) => request(client.post(`/recipes/${encodeURIComponent(id)}/run`, { input, triggerId })),
  fetchRecipeReceipt: (runId: string) => request(client.get(`/recipes/launches/${encodeURIComponent(runId)}`)),
  fetchConnections: () => request(client.get('/workspace/connections')),
  fetchKnowledgeWorkspace: () => request(client.get('/knowledge-workspace')),
  fetchDocumentStatus: () => request(client.get('/documents/status')),
  fetchLibrary: () => request(client.get('/library')),
  fetchKnowledgeReviews: (runIds: string[]) => request(client.get('/knowledge-impact/reviews?' + new URLSearchParams(runIds.map(id => ['runId', id])).toString())),
  fetchRunCheckContracts: () => request(client.get('/checks/contracts')),
  fetchOpenApiTools: () => request(client.get('/openapi-runner/tools')),
  exportOpenApiProfile: (input: { inspectionRunId: string; reviewedReadOnly: boolean; selections: { key: string; serverUrl: string }[] }) => request(client.post('/openapi-setup/profile', input)),
  fetchMcpTools: () => request(client.get('/mcp-runner/tools')),
  exportMcpProfile: (input: Record<string, unknown>) => request(client.post('/mcp-setup/profile', input)),
  uploadDocument: (file: File) => request(client.post('/documents/uploads', file, { headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': encodeURIComponent(file.name) } })),
  saveConnections: (values: Record<string, string | null>) => request(client.put('/workspace/connections', values)),
  runAgent: async (capability: string, input: Record<string, unknown>, triggerId: string) => {
    const result = await request(client.post('/workspace/runs', { capability, input, triggerId }));
    rememberRunInput(result.runId, input);
    return result;
  },
  fetchRun: (runId: string) => request(client.get(`/workspace/runs/${encodeURIComponent(runId)}`)),
  fetchRunActions: (runId: string) => request(client.get(`/workspace/runs/${encodeURIComponent(runId)}/actions`)),
  runAction: (runId: string, actionId: string, triggerId: string) => request(client.post(`/workspace/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(actionId)}`, { triggerId })),
  resumeRun: (runId: string, input: Record<string, unknown>, triggerId: string) => request(client.post(`/workspace/runs/${encodeURIComponent(runId)}/resume`, { input, triggerId })),
  fetchConfig: () => request(client.get("/config")),
  saveConfig: (data: any) => request(client.post("/config", data)),
  fetchDashboards: async () => {
    const data = await request(client.get("/dashboards"));
    return safeArray(data.dashboards);
  },
  getDashboardUrl: (filename: string) => `${API_BASE}/dashboards/${encodeURIComponent(filename)}`,
  fetchWeeklyReports: async (groupId?: string) => {
    const data = await request(client.get(`/weekly-reports${groupId ? `?groupId=${encodeURIComponent(groupId)}` : ''}`));
    return safeArray(data.reports);
  },
  getWeeklyReportUrl: (reportId: string) => `${API_BASE}/weekly-reports/${encodeURIComponent(reportId)}`,
  fetchLogs: async (page = 1, pageSize = 20, filters: any = {}) => {
    let url = `/logs?page=${page}&pageSize=${pageSize}`;
    if (filters.startDate) url += `&startDate=${filters.startDate}`;
    if (filters.endDate) url += `&endDate=${filters.endDate}`;
    if (filters.eventType && filters.eventType !== 'all') url += `&eventType=${filters.eventType}`;
    if (filters.groupId && filters.groupId !== 'all') url += `&groupId=${filters.groupId}`;
    const data = await request(client.get(url));
    return data;
  },
  fetchContexts: async (page = 1, pageSize = 15, filters: any = {}) => {
    let url = `/contexts?page=${page}&pageSize=${pageSize}`;
    if (filters.startDate) url += `&startDate=${filters.startDate}`;
    if (filters.endDate) url += `&endDate=${filters.endDate}`;
    if (filters.contextType && filters.contextType !== 'all') url += `&contextType=${filters.contextType}`;
    if (filters.chatType && filters.chatType !== 'all') url += `&chatType=${filters.chatType}`;
    if (filters.targetOpenId && filters.targetOpenId !== 'all') url += `&targetOpenId=${filters.targetOpenId}`;
    if (filters.groupId && filters.groupId !== 'all') url += `&groupId=${filters.groupId}`;
    const data = await request(client.get(url));
    return data;
  },
  fetchGroups: async () => {
    const data = await request(client.get("/feishu/groups"));
    return safeArray(data.groups);
  },
  fetchGroupMembers: async (chatId: string) => {
    const data = await request(client.get(`/feishu/groups/${chatId}/members`));
    return safeArray(data.members);
  },
  fetchCompanyMembers: async () => {
    const data = await request(client.get('/feishu/company-members'));
    return safeArray(data.members);
  },
  syncGroupMembers: (chatId: string) => request(client.post(`/feishu/groups/${encodeURIComponent(chatId)}/members/sync`)),
  syncCompanyMembers: () => request(client.post(`/feishu/company-members/sync`)),
  fetchMeetingSummaries: (groupId?: string, skip = 0, limit = 15) => request(client.get('/meeting-summaries', { params: { groupId, skip, limit } })),
  fetchMeetingSummaryContent: async (filepath: string) => {
    const data = await request(client.get(`/meeting-summaries/file/${filepath.split('/').map(encodeURIComponent).join('/')}`));
    return data;
  },
  getMeetingSummaryFileUrl: (filepath: string) => `${API_BASE}/meeting-summaries/file/${filepath.split('/').map(encodeURIComponent).join('/')}`,
  sendMeetingSummaryEmail: async (id: string) => {
    const data = await request(client.post(`/meeting-summaries/${id}/send-email`));
    return data;
  },
  fetchStandups: (date: string, groupId: string, type: 'normal' | 'task' = 'normal') => request(client.get(`/standups?date=${date}${groupId ? '&groupId=' + encodeURIComponent(groupId) : ''}&type=${type}`)),
  fetchStandupSummary: async (date: string, groupId: string) => {
    const data = await request(client.get(`/standups/summary?date=${date}&groupId=${encodeURIComponent(groupId)}`));
    return data.summary;
  },
  fetchHumanGantt: (params: { from: string; to: string; includeImplemented?: boolean; sync?: boolean }) => {
    const query = new URLSearchParams({
      from: params.from,
      to: params.to,
      includeImplemented: String(!!params.includeImplemented),
      sync: String(params.sync !== false),
    });
    return request(client.get(`/human-gantt?${query.toString()}`));
  },
  saveHumanGanttPlan: (taskId: string, plan: { employee_open_id: string; role: string; start: string; end: string }) =>
    request(client.post(`/human-gantt/tasks/${encodeURIComponent(taskId)}/plan`, plan)),
  deleteHumanGanttPlan: (taskId: string, plan: { employee_open_id: string; role: string }) =>
    request(client.delete(`/human-gantt/tasks/${encodeURIComponent(taskId)}/plan`, { data: plan })),
  triggerJob: (jobName: string, groupId: string, dryRun = true, sendToGroup = false) => request(client.post(`/jobs/${encodeURIComponent(jobName)}`, { groupId, dryRun, sendToGroup })),
};
