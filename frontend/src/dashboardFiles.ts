export interface DashboardFileMeta {
  filename: string;
  date: string;
  time: string;
  sortKey: string;
}

export const dashboardFilenameFromPath = (pathname: string): string | undefined => {
  try {
    const filename = decodeURIComponent(pathname.slice(1));
    return filename.length <= 255 && !/[\\/\p{Cc}]/u.test(filename) && filename.endsWith('.html') ? filename : undefined;
  } catch { return undefined; }
};

export const parseDashboardFilename = (filename: string): DashboardFileMeta => {
  const date = filename.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '';
  const snapshot = filename.match(/-(\d{8})T(\d{9})-[^.]+\.html$/)?.[2] || '';
  const time = snapshot ? `${snapshot.slice(0, 2)}:${snapshot.slice(2, 4)}:${snapshot.slice(4, 6)}` : '';
  return {
    filename,
    date,
    time,
    sortKey: `${date}T${snapshot || '000000000'}`,
  };
};

export const sortDashboardFiles = (files: string[]): string[] => [...files].sort((left, right) =>
  parseDashboardFilename(right).sortKey.localeCompare(parseDashboardFilename(left).sortKey)
);

export const dashboardMatchesGroup = (filename: string, group: any): boolean => {
  const chatId = String(group?.chat_id || '');
  const safeChatId = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const groupName = String(group?.name || '');
  return (!!chatId && (filename.includes(chatId) || filename.includes(safeChatId))) ||
    (!!groupName && filename.includes(groupName));
};
